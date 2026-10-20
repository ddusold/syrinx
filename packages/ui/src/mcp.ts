import type { FieldIssue, ViewResultMeta } from "@syrinx/core";
import {
  applyHostStyles,
  createAppsChannel,
  METHODS,
  type AppsChannel,
  type AppsChannelOptions,
  type AppsHostContext,
} from "./apps-channel.js";
import { ViewCallError, type BridgeResult, type HostBridge, type HostContext, type InputNeeded } from "./types.js";

// The `_meta` keys @syrinx/mcp writes. Repeated here so view bundles never import server code; a test keeps them equal.
export const META_PREFIX = "io.github.ddusold.syrinx";
export const ERROR_META_KEY = `${META_PREFIX}/error`;
export const VIEW_META_KEY = `${META_PREFIX}/view`;
export const SURFACE_META_KEY = `${META_PREFIX}/surface`;
export const ASKS_INLINE_META_KEY = `${META_PREFIX}/asksInline`;
export const INPUT_META_KEY = `${META_PREFIX}/input`;
export const RESUME_META_KEY = `${META_PREFIX}/resume`;

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
  // Questions for a view that asks inline arrive in _meta, shaped as input_required.
  const inline = result._meta?.[INPUT_META_KEY] as Pick<ToolResultLike, "inputRequests" | "requestState"> | undefined;
  if (inline) return fromToolResult({ resultType: "input_required", ...inline });
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

function toHostContext(context: AppsHostContext): HostContext {
  const host: HostContext = {};
  if (context.theme) host.theme = context.theme;
  if (context.displayMode) host.displayMode = context.displayMode;
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
export function createMcpBridge(channel: AppsChannel | AppsChannelOptions = {}): HostBridge {
  const apps = "connect" in channel ? channel : createAppsChannel(channel);
  let context: AppsHostContext = {};
  const hostListeners: ((host: HostContext) => void)[] = [];
  const resultListeners: ((result: BridgeResult) => void)[] = [];

  apps.on(METHODS.toolResult, (result) => {
    const converted = fromToolResult(result);
    for (const listener of resultListeners) listener(converted);
  });
  apps.on(METHODS.hostContextChanged, (changed) => {
    context = { ...context, ...changed };
    applyHostStyles(context);
    for (const listener of hostListeners) listener(toHostContext(context));
  });

  return {
    async connect() {
      context = await apps.connect();
      applyHostStyles(context);
      apps.reportSize();
    },
    host: () => toHostContext(context),
    onHostContext: (listener) => void hostListeners.push(listener),
    onResult: (listener) => void resultListeners.push(listener),
    async call(tool, input, { resume, inline }) {
      try {
        // Inline, questions and answers ride in _meta, which hosts pass through untouched. Otherwise the answers go
        // on the call's params, the retry channel MCP 2026-07-28 defines, and the host does the asking.
        const result = await apps.request<ToolResultLike>(METHODS.callTool, {
          name: tool,
          arguments: input as Record<string, unknown>,
          _meta: {
            [SURFACE_META_KEY]: "app",
            ...(inline ? { [ASKS_INLINE_META_KEY]: true, ...(resume ? { [RESUME_META_KEY]: resume } : {}) } : {}),
          },
          ...(inline ? {} : resume),
        });
        return fromToolResult(result);
      } catch (error) {
        return { error: new ViewCallError("host", error instanceof Error ? error.message : String(error)) };
      }
    },
    async openLink(url) {
      await apps.request(METHODS.openLink, { url });
    },
  };
}
