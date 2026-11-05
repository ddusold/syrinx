import type { FieldIssue, HostStylesMode, ViewCallResult, ViewResultMeta } from "@syrinx/core";
import {
  applyHostStyles,
  createAppsChannel,
  METHODS,
  type AppsChannel,
  type AppsChannelOptions,
  type AppsHostContext,
} from "./apps-channel.js";
import {
  ViewCallError,
  type BridgeResult,
  type DisplayMode,
  type HostBridge,
  type HostContext,
  type InputNeeded,
} from "./types.js";

// The `_meta` keys @syrinx/mcp writes. Repeated here so view bundles never import server code; a test keeps them equal.
export const META_PREFIX = "io.github.ddusold.syrinx";
export const ERROR_META_KEY = `${META_PREFIX}/error`;
export const VIEW_META_KEY = `${META_PREFIX}/view`;
export const SURFACE_META_KEY = `${META_PREFIX}/surface`;

/** The subset of an MCP tool result a view reads. */
export interface ToolResultLike {
  resultType?: string;
  inputRequests?: Record<string, { method?: string; params?: { message?: string; requestedSchema?: unknown } }>;
  requestState?: string;
  content?: readonly { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** Turns a tool result into data or a {@link ViewCallError}, plus the view metadata of bound operations. */
export function fromToolResult(result: ToolResultLike): BridgeResult {
  if (result.resultType === "input_required") {
    const requests: InputNeeded["requests"] = {};
    for (const [key, request] of Object.entries(result.inputRequests ?? {})) {
      requests[key] =
        request.method === "elicitation/create" && request.params?.message !== undefined
          ? { message: request.params.message, fields: request.params.requestedSchema ?? {} }
          : { unsupported: request.method ?? "unknown" };
    }
    return { input: { requests, ...(result.requestState !== undefined ? { requestState: result.requestState } : {}) } };
  }
  const meta = result._meta ?? {};
  const view = meta[VIEW_META_KEY] as ViewResultMeta | undefined;
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (result.isError) {
    const details = meta[ERROR_META_KEY] as { kind?: string; message?: string; issues?: FieldIssue[] } | undefined;
    return {
      error: new ViewCallError(
        details?.kind ?? "internal",
        details?.message ?? text ?? "The call failed.",
        details?.issues,
      ),
    };
  }
  let data = result.structuredContent;
  if (data === undefined && text !== undefined) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { data, ...(view ? { view } : {}) };
}

/**
 * Reads a view channel result into data, questions or an error. A result that is not a channel envelope (the host
 * answered for the server, as with "tool not allowed") is reported as `unavailable`, so the bridge falls back.
 */
export function fromViewCall(result: ToolResultLike): BridgeResult {
  let envelope = result.structuredContent as ViewCallResult | undefined;
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (envelope?.resultType === undefined && text !== undefined) {
    try {
      envelope = JSON.parse(text) as ViewCallResult;
    } catch {
      envelope = undefined;
    }
  }
  if (!envelope?.resultType) {
    return { error: new ViewCallError("unavailable", text ?? "The view channel returned no result.") };
  }
  if (envelope.resultType === "input_required") {
    return fromToolResult({
      resultType: "input_required",
      inputRequests: envelope.inputRequests,
      requestState: envelope.requestState,
    });
  }
  if (envelope.resultType === "error") {
    return { error: new ViewCallError(envelope.error.kind, envelope.error.message, envelope.error.issues) };
  }
  return { data: envelope.data, ...(envelope.view ? { view: envelope.view } : {}) };
}

function toHostContext(context: AppsHostContext): HostContext {
  const host: HostContext = {};
  if (context.theme) host.theme = context.theme;
  if (context.displayMode) host.displayMode = context.displayMode;
  if (context.availableDisplayModes) host.availableDisplayModes = context.availableDisplayModes;
  if (context.containerDimensions) host.containerDimensions = context.containerDimensions;
  if (context.safeAreaInsets) host.safeAreaInsets = context.safeAreaInsets;
  if (context.locale) host.locale = context.locale;
  if (context.timeZone) host.timeZone = context.timeZone;
  if (context.platform) host.platform = context.platform;
  return host;
}

/**
 * The bridge for MCP Apps hosts: the host pushes the tool result that opened the view, proxies the view's tool calls
 * to the server, and reports theme and size changes; the view reports its own size so the host can fit the iframe.
 */
export function createMcpBridge(
  channel: AppsChannel | AppsChannelOptions = {},
  options: { hostStyles?: HostStylesMode | undefined } = {},
): HostBridge {
  const apps = "connect" in channel ? channel : createAppsChannel(channel);
  const hostStyles = options.hostStyles ?? "apply";
  let context: AppsHostContext = {};
  let toolInput: unknown;
  let channelOpen = true;
  const hostListeners: ((host: HostContext) => void)[] = [];
  const resultListeners: ((result: BridgeResult) => void)[] = [];

  apps.on(METHODS.toolInput, (params) => {
    toolInput = params.arguments;
  });
  apps.on(METHODS.toolResult, (result) => {
    const converted = fromToolResult(result);
    for (const listener of resultListeners) listener(converted);
  });
  apps.on(METHODS.hostContextChanged, (changed) => {
    context = { ...context, ...changed };
    applyHostStyles(context, undefined, hostStyles);
    for (const listener of hostListeners) listener(toHostContext(context));
  });

  return {
    async connect() {
      context = await apps.connect();
      applyHostStyles(context, undefined, hostStyles);
      apps.reportSize();
    },
    host: () => toHostContext(context),
    toolInput: () => toolInput,
    onHostContext: (listener) => void hostListeners.push(listener),
    onResult: (listener) => void resultListeners.push(listener),
    async call(tool, input, { app, operation, resume, viewCall }) {
      if (viewCall && channelOpen) {
        let result: BridgeResult;
        try {
          result = fromViewCall(
            await apps.request<ToolResultLike>(METHODS.callTool, {
              name: viewCall.tool,
              arguments: { app, operation, input, token: viewCall.token, ...(resume ? { resume } : {}) },
              _meta: { [SURFACE_META_KEY]: "app" },
            }),
          );
        } catch (error) {
          // The host refused to relay the channel tool.
          result = { error: new ViewCallError("unavailable", error instanceof Error ? error.message : String(error)) };
        }
        if (result.error?.kind !== "unavailable") return result;
        // The server or host refused the channel: call directly from now on, and let the host do the asking.
        channelOpen = false;
      }
      try {
        // Answers go on the call's params, the retry channel MCP 2026-07-28 defines; the host does the asking.
        const result = await apps.request<ToolResultLike>(METHODS.callTool, {
          name: tool,
          arguments: input as Record<string, unknown>,
          _meta: { [SURFACE_META_KEY]: "app" },
          ...resume,
        });
        return fromToolResult(result);
      } catch (error) {
        return { error: new ViewCallError("host", error instanceof Error ? error.message : String(error)) };
      }
    },
    async openLink(url) {
      await apps.request(METHODS.openLink, { url });
    },
    async downloadFile(file) {
      // ui/download-file takes standard MCP resource contents: here one embedded resource with the bytes inline.
      const uri = `file:///${encodeURIComponent(file.name)}`;
      const resource =
        file.base64 !== undefined
          ? { uri, mimeType: file.mimeType, blob: file.base64 }
          : { uri, mimeType: file.mimeType, text: file.text ?? "" };
      await hostRequest(METHODS.downloadFile, { contents: [{ type: "resource", resource }] }, "download the file");
    },
    async requestDisplayMode(mode) {
      try {
        const result = await apps.request<{ mode?: DisplayMode }>(METHODS.requestDisplayMode, { mode });
        return result.mode ?? context.displayMode ?? "inline";
      } catch (error) {
        throw new ViewCallError(
          "host",
          `This host cannot change display modes: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    async sendMessage(text) {
      await hostRequest(METHODS.message, { role: "user", content: [{ type: "text", text }] }, "send a message");
    },
  };

  /** A host that lacks the method rejects it; one that has it can still decline (`isError`). Both reach the view alike. */
  async function hostRequest(method: string, params: Record<string, unknown>, what: string) {
    let result: { isError?: boolean };
    try {
      result = await apps.request<{ isError?: boolean }>(method, params);
    } catch (error) {
      throw new ViewCallError(
        "host",
        `This host cannot ${what}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.isError) throw new ViewCallError("host", `The host declined to ${what}.`);
  }
}
