interface FormObserverHandle {
  readonly dirty: boolean;
  readonly active: boolean;
}

const OBSERVER_KEY = Symbol.for("tabReaper.formObserver");
const formElementsGetter = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "elements")?.get;

function getObserverHandle(): FormObserverHandle | undefined {
  return (globalThis as Record<symbol, FormObserverHandle | undefined>)[OBSERVER_KEY];
}

function setObserverHandle(handle: FormObserverHandle | undefined): void {
  const store = globalThis as Record<symbol, FormObserverHandle | undefined>;
  if (handle) store[OBSERVER_KEY] = handle;
  else delete store[OBSERVER_KEY];
}

function hasRuntime(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
}

function installObserver() {
  if (getObserverHandle() || !hasRuntime() || !chrome.runtime.onMessage) return;
  const controller = new AbortController();
  // Signature of each field before its pending edit. undefined: no comparable signature.
  const originals = new WeakMap<HTMLElement, string | undefined>();
  // Edited fields are compared with their originals when the flag is read, never on the keystroke path.
  const edited = new Set<HTMLElement>();
  let removedEdit = false;
  let active = false;
  let authorizing = false;

  function stop() {
    active = false;
    controller.abort();
    edited.clear();
    setObserverHandle(undefined);
    try {
      if (typeof chrome !== "undefined") chrome.runtime?.onMessage?.removeListener(onMessage);
    } catch {
      // Extension context may already be invalidated.
    }
  }
  function onMessage(message: unknown) {
    if (message === "tab-reaper-stop-form-observer") stop();
  }
  try {
    chrome.runtime.onMessage.addListener(onMessage);
  } catch {
    return;
  }
  setObserverHandle({
    get active() { return active; },
    get dirty() { return hasPendingEdits(); },
  });

  // Cheap checks only. Edited fields skip the layout checks in eligible() on later keystrokes.
  function control(event: Event): HTMLElement | undefined {
    if (!event.isTrusted) return;
    if (!hasRuntime()) {
      stop();
      return;
    }
    const target = event.composedPath()[0];
    const element = target instanceof HTMLLabelElement ? target.control : target;
    if (!(element instanceof HTMLElement)) return;
    let el: HTMLElement = element;
    if (el instanceof HTMLInputElement) {
      if (el.disabled || el.readOnly || /^(password|hidden|search|button|image|reset|submit)$/.test(el.type)) return;
      if (!el.form && !/^(text|email|url|tel)$/.test(el.type)) return;
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.disabled || el.readOnly) return;
    } else if (el instanceof HTMLSelectElement) {
      if (el.disabled || !el.form) return;
    } else {
      if (!el.isContentEditable) return;
      while (el.parentElement?.isContentEditable) el = el.parentElement;
    }
    return el;
  }

  function eligible(el: HTMLElement): boolean {
    const excluded = "[inert], [aria-hidden=true], [aria-readonly=true], header, nav, [role=toolbar], [role=search], [role=navigation], [role=menubar], [role=searchbox], [role=combobox]";
    if (el.closest(excluded) || el.matches(":disabled") || !el.offsetWidth || !el.offsetHeight) return false;
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }

  // Only a local fingerprint survives the event. Long edits usually differ in length alone.
  function fingerprint(value: string, original?: string): string {
    const prefix = value.length + ":";
    if (original && !original.startsWith(prefix)) return prefix;
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return prefix + hash;
  }

  function signature(el: HTMLElement, original?: string): string | undefined {
    if (el instanceof HTMLSelectElement) return Array.from(el.selectedOptions, option => option.index).join(",");
    if (el instanceof HTMLInputElement) {
      if (el.type === "password") return;
      if (el.type === "checkbox" || el.type === "radio") return String(el.checked);
      return fingerprint(el.value, original);
    }
    if (el instanceof HTMLTextAreaElement) return fingerprint(el.value, original);
    if (el.querySelector("input, textarea, select")) return;
    // Chromium leaves a placeholder line break after deleting the last character.
    if (el.childNodes.length === 1 && el.firstChild instanceof HTMLBRElement) return fingerprint("", original);
    return fingerprint(el.innerHTML, original);
  }

  function controls(el: HTMLElement): HTMLElement[] {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name || !el.form) return [el];
    // Bypass HTMLFormElement named-property overrides (e.g. <input name="elements">).
    const formElements = formElementsGetter ? formElementsGetter.call(el.form) : el.form.elements;
    if (!(formElements instanceof HTMLFormControlsCollection)) return [el];
    const group = formElements.namedItem(el.name);
    if (!(group instanceof RadioNodeList)) return [el];
    return Array.from(group).filter((radio): radio is HTMLInputElement =>
      radio instanceof HTMLInputElement && radio.type === "radio" && radio.name === el.name);
  }

  // Records the signature before an edit starts. Pickers and toggles can emit input without beforeinput.
  function remember(event: Event) {
    const el = control(event);
    if (!el || edited.has(el) || !eligible(el)) return;
    if (event.type !== "pointerdown") void authorize();
    for (const field of controls(el)) {
      if (!edited.has(field)) originals.set(field, signature(field));
    }
  }
  function changed(event: Event) {
    const el = control(event);
    if (!el || edited.has(el) || !eligible(el)) return;
    for (const field of controls(el)) edited.add(field);
  }

  // Reverting a field, by the user or by the app after sending, clears it.
  // A removed edited field keeps the document protected because the app can keep the draft while rebuilding its UI.
  function hasPendingEdits(): boolean {
    for (const el of edited) {
      const original = originals.get(el);
      if (!el.isConnected) {
        removedEdit = true;
        edited.delete(el);
      } else if (original !== undefined && signature(el, original) === original) {
        edited.delete(el);
      }
    }
    return removedEdit || edited.size > 0;
  }

  // Frames ask the worker only after their first eligible interaction, so loading a page sends no messages.
  async function authorize() {
    if (active || authorizing) return;
    if (!hasRuntime()) {
      stop();
      return;
    }
    authorizing = true;
    let enabled = false;
    try {
      // Chrome can retain a registered script after the user revokes scripting alone.
      enabled = (await chrome.runtime.sendMessage("tab-reaper-form-access")) === true;
    } catch {
      enabled = false;
    } finally {
      authorizing = false;
    }
    if (controller.signal.aborted) return;
    if (enabled) active = true;
    else stop();
  }

  const capture = { capture: true, signal: controller.signal };
  for (const name of ["focusin", "pointerdown", "beforeinput"]) window.addEventListener(name, remember, capture);
  window.addEventListener("input", changed, capture);
  // A document restored from the back/forward cache asks again on its next interaction.
  window.addEventListener("pagehide", () => { active = false; }, capture);
}

installObserver();
