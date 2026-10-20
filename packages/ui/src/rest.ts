import type { FieldIssue, HostStylesMode, ViewBoot } from "@syrinx/core";
import { fromToolResult, type ToolResultLike } from "./mcp.js";
import { ViewCallError, type BridgeResult, type HostBridge, type HostContext } from "./types.js";

export interface RestBridgeOptions {
  /** Where the app's operations are served: `POST {base}/{operation}`, for example `/api/contacts/ops`. */
  base: string;
  /** The root view, `app/view`: the view metadata tagged onto results of bound operations. */
  view: string;
  /**
   * The operations that render the view, each with the component it shows (undefined: the whole view). A result of
   * any other operation is plain data for the caller and leaves the view alone.
   */
  bound: Readonly<Record<string, string | undefined>>;
  /** Headers for every request, such as `authorization`. Called per request, so a token can change. */
  headers?: () => HeadersInit | Promise<HeadersInit>;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** What the page tells the view about where it is drawn; defaults to the system theme, fullscreen, the browser's locale. */
  host?: HostContext;
}

/** An RFC 9457 problem as `@syrinx/rest` writes it: `title` is the Syrinx error kind, `detail` the message. */
interface Problem {
  title?: string;
  detail?: string;
  errors?: readonly FieldIssue[];
}

/**
 * A host bridge for a plain web page: the view's operation calls go to the REST surface instead of through MCP, and
 * failures arrive as {@link ViewCallError}s the view already handles. Pair it with {@link restBoot} and `startView`.
 */
export function createRestBridge(options: RestBridgeOptions): HostBridge {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const host: HostContext = options.host ?? {
    theme: dark ? "dark" : "light",
    // A page has room: views lift the height caps they keep for embedded host frames.
    displayMode: "fullscreen",
    platform: "web",
    ...(typeof navigator === "undefined" ? {} : { locale: navigator.language }),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  // HeadersInit may be a Headers object or pairs; requests take a plain record.
  const requestHeaders = async () => {
    const headers: Record<string, string> = {};
    new Headers(await options.headers?.()).forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  };

  return {
    connect: () => Promise.resolve(),
    host: () => host,
    onHostContext: () => undefined,
    onResult: () => undefined,
    async call(_tool, input, { operation, resume }) {
      let response: Response;
      try {
        response = await doFetch(`${options.base}/${operation}${resume ? "/resume" : ""}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(await requestHeaders()) },
          body: JSON.stringify(resume ? { input: input ?? {}, ...resume } : (input ?? {})),
        });
      } catch (error) {
        return { error: new ViewCallError("unreachable", error instanceof Error ? error.message : String(error)) };
      }
      const body = (await response.json().catch(() => undefined)) as
        | (Problem & {
            resultType?: string;
            data?: unknown;
            inputRequests?: ToolResultLike["inputRequests"];
            requestState?: string;
          })
        | undefined;
      if (!response.ok) {
        return {
          error: new ViewCallError(
            body?.title ?? "internal",
            body?.detail ?? `${response.status} ${response.statusText}`,
            body?.errors,
          ),
        };
      }
      if (body?.resultType === "input_required") {
        return fromToolResult({
          resultType: "input_required",
          ...(body.inputRequests ? { inputRequests: body.inputRequests } : {}),
          ...(body.requestState !== undefined ? { requestState: body.requestState } : {}),
        });
      }
      const result: BridgeResult = { data: body?.data };
      if (operation in options.bound) {
        const component = options.bound[operation];
        result.view = { view: options.view, op: operation, schemaVersion: "", ...(component ? { component } : {}) };
      }
      return result;
    },
    openLink: (url) => {
      window.open(url, "_blank", "noopener");
      return Promise.resolve();
    },
  };
}

export interface RestBootOptions {
  /** The root view, `app/view`. */
  view: string;
  /** The operations the view calls or is bound to, as `app.operation` or bare names of the view's own app. */
  operations: readonly string[];
  /** Feature flags per `app/view`; a bare record is for the root view. */
  features?: Readonly<Record<string, boolean>> | Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  hostStyles?: HostStylesMode;
}

/**
 * The boot data `startView` needs on a page, in place of the shell's: it names the operations the view may call, which
 * the REST bridge sends by operation name (the route's `tool` is unused).
 */
export function restBoot(options: RestBootOptions): ViewBoot {
  const app = options.view.slice(0, options.view.indexOf("/"));
  const features = options.features ?? {};
  const perView = Object.values(features).some((value) => typeof value === "object");
  return {
    view: options.view,
    channel: "rest",
    operations: Object.fromEntries(
      options.operations.map((op) => [op.includes(".") ? op : `${app}.${op}`, { tool: op.slice(op.indexOf(".") + 1) }]),
    ),
    features: perView
      ? (features as Record<string, Readonly<Record<string, boolean>>>)
      : { [options.view]: features as Readonly<Record<string, boolean>> },
    ...(options.hostStyles ? { hostStyles: options.hostStyles } : {}),
  };
}
