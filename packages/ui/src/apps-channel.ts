/**
 * The view side of the MCP Apps protocol (`io.modelcontextprotocol/ui`): JSON-RPC 2.0 over postMessage with the host
 * window. Only what Syrinx views use, with no dependencies, so view bundles stay small. The ext-apps `App` class
 * does the same with the full MCP client and zod behind it, which is most of a bundle's weight. The end-to-end
 * tests run every bundle against the real ext-apps host (`AppBridge`), so a drift from the protocol fails CI.
 */

import type { HostStylesMode } from "@syrinx/core";

/** The MCP Apps protocol revision this channel speaks (ext-apps `LATEST_PROTOCOL_VERSION`). */
export const APPS_PROTOCOL_VERSION = "2026-01-26";

export const METHODS = {
  initialize: "ui/initialize",
  initialized: "ui/notifications/initialized",
  toolInput: "ui/notifications/tool-input",
  toolResult: "ui/notifications/tool-result",
  toolCancelled: "ui/notifications/tool-cancelled",
  hostContextChanged: "ui/notifications/host-context-changed",
  sizeChanged: "ui/notifications/size-changed",
  resourceTeardown: "ui/resource-teardown",
  openLink: "ui/open-link",
  downloadFile: "ui/download-file",
  message: "ui/message",
  callTool: "tools/call",
  ping: "ping",
} as const;

/** The parts of the host context Syrinx reads (MCP Apps `McpUiHostContext`); hosts may send more. */
export interface AppsHostContext {
  theme?: "light" | "dark";
  displayMode?: "inline" | "fullscreen" | "pip";
  containerDimensions?: { width?: number; maxWidth?: number; height?: number; maxHeight?: number };
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
  locale?: string;
  timeZone?: string;
  platform?: "web" | "desktop" | "mobile";
  styles?: { variables?: Record<string, string | undefined>; css?: { fonts?: string } };
  [key: string]: unknown;
}

interface Message {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class AppsProtocolError extends Error {
  override readonly name = "AppsProtocolError";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface AppsChannelOptions {
  /** The host window. Defaults to `window.parent`. */
  host?: Window;
  /** How long a request waits for the host. Tool calls can be slow, so the default is generous: 5 minutes. */
  timeoutMs?: number;
  appInfo?: { name: string; version: string };
}

export interface AppsChannel {
  /** Handshake: `ui/initialize`, then `ui/notifications/initialized`. Resolves with the host context. */
  connect(): Promise<AppsHostContext>;
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): void;
  /** Handles one notification method from the host. */
  on(method: string, handler: (params: Record<string, unknown>) => void): void;
  /** Reports the document's size whenever it changes, so the host can fit the iframe. Returns a stop function. */
  reportSize(): () => void;
  close(): void;
}

let viewportWarned = false;

export function createAppsChannel(options: AppsChannelOptions = {}): AppsChannel {
  const host = options.host ?? window.parent;
  const timeoutMs = options.timeoutMs ?? 300_000;
  let nextId = 0;
  const pending = new Map<
    string | number,
    { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  const handlers = new Map<string, (params: Record<string, unknown>) => void>();

  // Messages are JSON by definition. Converting them first also turns framework proxies (a Vue `ref` passed as tool
  // arguments or as an answer) into plain data, which postMessage would otherwise refuse to clone.
  const send = (message: Omit<Message, "jsonrpc">) => {
    host.postMessage(JSON.parse(JSON.stringify({ jsonrpc: "2.0", ...message })) as Message, "*");
  };

  const onMessage = (event: MessageEvent) => {
    // Only the host may talk to the view; other frames and extensions are ignored.
    if (event.source !== host) return;
    const message = event.data as Partial<Message> | null;
    if (message?.jsonrpc !== "2.0") return;
    if (message.method === undefined && message.id !== undefined) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error)
        waiting.reject(new AppsProtocolError(message.error.code, message.error.message, message.error.data));
      else waiting.resolve(message.result);
      return;
    }
    if (message.method === undefined) return;
    if (message.id !== undefined) {
      // Requests from the host: teardown and ping are answered; anything else is not implemented here.
      if (message.method === METHODS.resourceTeardown || message.method === METHODS.ping) {
        send({ id: message.id, result: {} });
      } else {
        send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      }
      return;
    }
    handlers.get(message.method)?.(message.params ?? {});
  };
  window.addEventListener("message", onMessage);

  const request = <T>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AppsProtocolError(-32001, `The host did not answer ${method} within ${timeoutMs} ms.`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve, reject, timer });
      send({ id, method, params });
    });

  return {
    async connect() {
      const result = await request<{ hostContext?: AppsHostContext }>(METHODS.initialize, {
        appInfo: options.appInfo ?? { name: "syrinx-view", version: "0.1.0" },
        appCapabilities: {},
        protocolVersion: APPS_PROTOCOL_VERSION,
      });
      send({ method: METHODS.initialized, params: {} });
      return result.hostContext ?? {};
    },
    request,
    notify: (method, params = {}) => {
      send({ method, params });
    },
    on: (method, handler) => {
      handlers.set(method, handler);
    },
    reportSize() {
      if (typeof document !== "undefined" && !viewportWarned) {
        viewportWarned = true;
        const rules = findViewportHeightRules(document.styleSheets);
        if (rules.length) {
          console.warn(
            `[syrinx] ${rules.slice(0, 3).join(", ")} size by viewport height (vh). The host sizes this frame to the view, so such a view can only grow; size by content, or wrap it in ViewFrame.`,
          );
        }
      }
      // Measured as ext-apps does: the content's natural height, and the viewport's width.
      let scheduled = false;
      let last = { width: 0, height: 0 };
      const measure = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          const root = document.documentElement;
          const previous = root.style.height;
          root.style.height = "max-content";
          const height = Math.ceil(root.getBoundingClientRect().height);
          root.style.height = previous;
          const width = Math.ceil(window.innerWidth);
          if (width === last.width && height === last.height) return;
          last = { width, height };
          send({ method: METHODS.sizeChanged, params: { width, height } });
        });
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(document.documentElement);
      observer.observe(document.body);
      return () => {
        observer.disconnect();
      };
    },
    close() {
      window.removeEventListener("message", onMessage);
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new AppsProtocolError(-32000, "The view closed."));
      }
      pending.clear();
    },
  };
}

/** The parts of a stylesheet {@link findViewportHeightRules} reads; real `CSSStyleSheet`s fit. */
export interface SheetLike {
  cssRules: ArrayLike<{ cssText?: string; selectorText?: string }>;
}

/**
 * Selectors whose `height` or `min-height` is in viewport units (`100vh`, `100dvh`, ...). In an MCP Apps host the frame
 * is sized to the view, so the viewport is the view's own previous height: such a rule can only ever grow it. Unreadable
 * (cross-origin) sheets are skipped. Returns the selectors, for a warning.
 */
export function findViewportHeightRules(sheets: ArrayLike<SheetLike>): string[] {
  const found: string[] = [];
  for (const sheet of Array.from(sheets)) {
    let rules: ArrayLike<{ cssText?: string; selectorText?: string }>;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (rule.selectorText && /(?:^|[;{\s])(?:min-)?height\s*:[^;}]*\d(?:[sld]?vh)\b/i.test(rule.cssText ?? "")) {
        found.push(rule.selectorText);
      }
    }
  }
  return found;
}

/**
 * Applies the host's CSS variables and font faces, as MCP Apps hosts send them in the host context. `mode` is the
 * view's `hostStyles`: `fonts` skips the variables, `ignore` skips both.
 */
export function applyHostStyles(
  context: AppsHostContext,
  root: HTMLElement = document.documentElement,
  mode: HostStylesMode = "apply",
): void {
  if (mode === "ignore") return;
  if (mode === "apply") {
    for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
      if (value !== undefined) root.style.setProperty(name, value);
    }
  }
  const fonts = context.styles?.css?.fonts;
  if (fonts && !document.getElementById("__mcp-host-fonts")) {
    const style = document.createElement("style");
    style.id = "__mcp-host-fonts";
    style.textContent = fonts;
    document.head.appendChild(style);
  }
}
