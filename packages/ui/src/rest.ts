import type { App, FieldIssue, HostStylesMode, Operation, StandardSchemaV1, ViewBoot } from "@syrinx/core";
import { fromToolResult, type ToolResultLike } from "./mcp.js";
import { ViewCallError, type BridgeResult, type HostBridge, type HostContext, type InputResume } from "./types.js";

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

interface RestTransport {
  /** Where the app's operations are served: `POST {base}/{operation}`. */
  base: string;
  headers?: (() => HeadersInit | Promise<HeadersInit>) | undefined;
  fetch?: typeof fetch | undefined;
}

/**
 * POSTs one operation to the REST surface (or its `/resume` path) and reads the answer into a bridge result: data,
 * questions to answer, or a {@link ViewCallError} for an RFC 9457 problem or a network failure.
 */
function restCall(transport: RestTransport) {
  const doFetch = transport.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  // HeadersInit may be a Headers object or pairs; requests take a plain record.
  const requestHeaders = async () => {
    const headers: Record<string, string> = {};
    new Headers(await transport.headers?.()).forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  };
  return async (operation: string, input: unknown, resume?: InputResume): Promise<BridgeResult> => {
    let response: Response;
    try {
      response = await doFetch(`${transport.base}/${operation}${resume ? "/resume" : ""}`, {
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
    return { data: body?.data };
  };
}

/**
 * A host bridge for a plain web page: the view's operation calls go to the REST surface instead of through MCP, and
 * failures arrive as {@link ViewCallError}s the view already handles. Pair it with {@link restBoot} and `startView`.
 */
export function createRestBridge(options: RestBridgeOptions): HostBridge {
  const post = restCall(options);
  const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const host: HostContext = options.host ?? {
    theme: dark ? "dark" : "light",
    // A page has room: views lift the height caps they keep for embedded host frames.
    displayMode: "fullscreen",
    platform: "web",
    ...(typeof navigator === "undefined" ? {} : { locale: navigator.language }),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  return {
    connect: () => Promise.resolve(),
    host: () => host,
    onHostContext: () => undefined,
    onResult: () => undefined,
    async call(_tool, input, { operation, resume }) {
      const result = await post(operation, input, resume);
      if (result.error ?? result.input) return result;
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

type InputOf<O> = O extends Operation ? StandardSchemaV1.InferInput<O["input"]> : never;
type OutputOf<O> = O extends Operation ? StandardSchemaV1.InferOutput<O["output"]> : never;

/** A typed method per operation of the app `A`: its input in, its output out. */
export type RestClient<A extends App> = {
  [K in keyof A["operations"] & string]: (input: InputOf<A["operations"][K]>) => Promise<OutputOf<A["operations"][K]>>;
};

export interface RestClientOptions {
  /** The app's name, as in its URLs: `{base}/{app}/ops/{operation}`. */
  app: string;
  /** Where the REST surface is mounted. Defaults to `/api`. */
  base?: string;
  headers?: () => HeadersInit | Promise<HeadersInit>;
  fetch?: typeof fetch;
}

/**
 * A typed client for a Syrinx app's REST surface, for pages and scripts. Import the app's type only, so no server code
 * reaches the bundle: `createRestClient<typeof contacts>({ app: "contacts", headers })`, then
 * `await client.get({ personId })`. Failures reject with a {@link ViewCallError} (`kind`, `message`, `issues`). An
 * operation that asks the user a question rejects with kind `input_required`; ask through a view, which can.
 */
export function createRestClient<A extends App>(options: RestClientOptions): RestClient<A> {
  const post = restCall({
    base: `${options.base ?? "/api"}/${options.app}/ops`,
    headers: options.headers,
    fetch: options.fetch,
  });
  return new Proxy({} as RestClient<A>, {
    get: (_target, operation) =>
      // Not `then`: a client must not look like a promise when returned from an async function.
      typeof operation === "string" && operation !== "then"
        ? async (input: unknown) => {
            const result = await post(operation, input ?? {});
            if (result.error) throw result.error;
            if (result.input) {
              throw new ViewCallError(
                "input_required",
                `${operation} asks the user a question; a client cannot answer it.`,
              );
            }
            return result.data;
          }
        : undefined,
  });
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
