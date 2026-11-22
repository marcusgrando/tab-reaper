interface Window {
  tabReaperFormObserver?: { readonly dirty: boolean; active: boolean };
}

type FieldState = { original?: string; dirty: boolean };

function installObserver() {
  if (window.tabReaperFormObserver) return;
  const controller = new AbortController();
  const fields = new WeakMap<HTMLElement, FieldState>();
  let dirtyCount = 0;
  const observer = { active: false, get dirty() { return dirtyCount > 0; } };
  window.tabReaperFormObserver = observer;

  function stop() {
    observer.active = false;
    controller.abort();
    delete window.tabReaperFormObserver;
    chrome.runtime.onMessage.removeListener(onMessage);
  }
  function onMessage(message: unknown) {
    if (message === "tab-reaper-stop-form-observer") stop();
  }
  chrome.runtime.onMessage.addListener(onMessage);

  function field(event: Event): HTMLElement | undefined {
    if (!observer.active || !event.isTrusted || !chrome.runtime.id) return;
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
    const excluded = "[inert], [aria-hidden=true], [aria-readonly=true], header, nav, [role=toolbar], [role=search], [role=navigation], [role=menubar], [role=searchbox], [role=combobox]";
    if (el.closest(excluded) || el.matches(":disabled") || !el.offsetWidth || !el.offsetHeight) return;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return;
    return el;
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
    const group = el.form.elements.namedItem(el.name);
    if (!(group instanceof RadioNodeList)) return [el];
    return Array.from(group).filter((radio): radio is HTMLInputElement =>
      radio instanceof HTMLInputElement && radio.type === "radio" && radio.name === el.name);
  }

  function remember(event: Event) {
    const el = field(event);
    if (!el) return;
    for (const control of controls(el)) {
      if (!fields.get(control)?.dirty) fields.set(control, { original: signature(control), dirty: false });
    }
  }
  function edited(event: Event) {
    const el = field(event);
    if (!el) return;
    for (const control of controls(el)) {
      const state = fields.get(control) ?? { dirty: false };
      const dirty = state.original === undefined || state.original !== signature(control, state.original);
      if (state.dirty !== dirty) dirtyCount += dirty ? 1 : -1;
      state.dirty = dirty;
      fields.set(control, state);
    }
  }

  function reset(event: Event) {
    const form = event.target;
    if (!event.isTrusted || !observer.active || !(form instanceof HTMLFormElement)) return;
    // Reset is cancelable. Compare after the browser has applied its default action.
    setTimeout(() => {
      if (!observer.active || event.defaultPrevented) return;
      for (const el of form.elements) {
        if (!(el instanceof HTMLElement)) continue;
        const state = fields.get(el);
        if (state?.dirty && state.original !== undefined && signature(el, state.original) === state.original) {
          state.dirty = false;
          dirtyCount--;
        }
      }
    }, 0);
  }

  const capture = { capture: true, signal: controller.signal };
  async function authorize() {
    // Chrome can retain a registered script after the user revokes scripting alone.
    const enabled = await chrome.runtime.sendMessage("tab-reaper-form-access").catch(() => false);
    if (controller.signal.aborted) return;
    if (enabled !== true) {
      stop();
      return;
    }
    observer.active = true;
    // Pickers and toggles can emit input without beforeinput.
    for (const name of ["focusin", "pointerdown", "beforeinput"]) window.addEventListener(name, remember, capture);
    window.addEventListener("input", edited, capture);
    window.addEventListener("reset", reset, capture);
  }
  window.addEventListener("pagehide", () => { observer.active = false; }, capture);
  window.addEventListener("pageshow", event => { if (event.persisted) void authorize(); }, capture);
  void authorize();
}

installObserver();
