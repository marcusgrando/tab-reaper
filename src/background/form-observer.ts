import { HTTP_HOST_ORIGINS, createAsyncQueue, isInternalUrl, loadConfig, withTimeout } from "../shared/config.ts";
import { hasHostAccessPermission } from "./sampler.ts";

const scriptId = "tab-reaper-form-observer";
const scriptFile = "form-observer.js";
const TAB_OP_TIMEOUT_MS = 1000;
const enqueue = createAsyncQueue();

export function reconcileFormObserver(refreshOpenTabs = false): Promise<void> {
  return enqueue(async () => {
    const config = await loadConfig();
    const enabled = config.protectUnsavedForms && await hasHostAccessPermission();
    const scripting = chrome.scripting;
    const canRegister = scripting && await chrome.permissions.contains({ permissions: ["scripting"] });
    const registered = canRegister &&
      (await scripting.getRegisteredContentScripts({ ids: [scriptId] })).length > 0;
    if (enabled && canRegister) {
      if (!registered) {
        await scripting.registerContentScripts([{
          id: scriptId, js: [scriptFile], matches: HTTP_HOST_ORIGINS, allFrames: true,
          runAt: "document_start", matchOriginAsFallback: true,
        }]);
      }
      if (registered && !refreshOpenTabs) return;
    } else {
      if (registered) await scripting.unregisterContentScripts({ ids: [scriptId] });
      if (!registered && !refreshOpenTabs) return;
    }
    const tabs = await chrome.tabs.query({ discarded: false });
    await Promise.all(tabs.map(async tab => {
      if (tab.id === undefined || tab.discarded || tab.incognito || isInternalUrl(tab.url)) return;
      try {
        if (enabled && canRegister) {
          await withTimeout(
            scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: [scriptFile], injectImmediately: true }),
            TAB_OP_TIMEOUT_MS,
          );
        } else {
          await withTimeout(chrome.tabs.sendMessage(tab.id, "tab-reaper-stop-form-observer"), TAB_OP_TIMEOUT_MS);
        }
      } catch {
        // Restricted documents, closed tabs, hung renderers, and frames without an observer are expected.
      }
    }));
  }).catch(error => {
    console.warn("Could not update the form observer", error);
  });
}
