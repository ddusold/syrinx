import type { ViewBoot } from "@syrinx/core";
import { ViewCallError, type BridgeResult, type HostBridge, type HostContext } from "./types.js";

/**
 * The gallery's bridge: no host and no server. It delivers the boot's sample data once and refuses calls, so a
 * view can be looked at, and screenshotted, on its own.
 */
export function createPreviewBridge(boot: ViewBoot): HostBridge {
  const resultListeners: ((result: BridgeResult) => void)[] = [];
  // The gallery's theme toggle sets ?theme=light|dark on the preview page; otherwise the system theme applies.
  const forced = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("theme");
  const dark =
    forced === "dark" ||
    (forced !== "light" && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
  const host: HostContext = { theme: dark ? "dark" : "light", displayMode: "inline", platform: "web" };
  return {
    async connect() {
      const preview = boot.preview;
      if (!preview) return;
      // Deliver after the view mounts, as a host would after the handshake.
      await Promise.resolve();
      queueMicrotask(() => {
        const result: BridgeResult = { data: preview.data };
        if (preview.op) {
          result.view = {
            view: boot.view,
            op: preview.op,
            schemaVersion: "",
            ...(preview.component ? { component: preview.component } : {}),
          };
        }
        for (const listener of resultListeners) listener(result);
      });
    },
    host: () => host,
    onHostContext: () => undefined,
    onResult: (listener) => void resultListeners.push(listener),
    call: (_tool, _input, { app, operation }) =>
      Promise.resolve({ error: new ViewCallError("unreachable", `The gallery cannot call ${app}.${operation}.`) }),
    openLink: (url) => {
      window.open(url, "_blank", "noopener");
      return Promise.resolve();
    },
  };
}
