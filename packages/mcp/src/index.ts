import {
  lintApp,
  localAuthBypass,
  logUnhandled,
  resolveRequireAuth,
  SyrinxError,
  type Principal,
  type Tenant,
} from "@syrinx/core";
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  oauthMetadataResponse,
  originValidationResponse,
  validateHostHeader,
  type AuthMetadataOptions,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import {
  buildServer,
  checkMembers,
  routineLogger,
  type Caller,
  type ProjectionOptions,
  type Scope,
} from "./projection.js";

export {
  APPS_EXTENSION,
  ASKS_META_KEY,
  buildServer,
  ERROR_META_KEY,
  META_PREFIX,
  SURFACE_META_KEY,
  VIEW_META_KEY,
  VIEW_CALL_TOOL,
  VIEW_MIME_TYPE,
  viewUri,
} from "./projection.js";
export type { Caller, Era, ProjectionOptions, Scope, Serving, ViewShell, ViewShells } from "./projection.js";
export type { ViewCallResult } from "@syrinx/core";
export type { AuthMetadataOptions } from "@modelcontextprotocol/server";

export interface McpOptions<Deps = unknown> extends ProjectionOptions<Deps> {
  /**
   * Turns a request into a principal, as on the REST surface. Return undefined for an anonymous caller; throw
   * `errors.unauthenticated()` for credentials that are present but invalid.
   */
  authenticate?: (request: Request) => Principal | undefined | Promise<Principal | undefined>;
  resolveTenant?: (
    principal: Principal | undefined,
    request: Request,
  ) => Tenant | undefined | Promise<Tenant | undefined>;
  /** Where the endpoints live: `{basePath}` serves every app, `{basePath}/{app}` one app. Defaults to `/mcp`. */
  basePath?: string;
  /**
   * Hostnames the Host header may name (DNS rebinding protection). Defaults to localhost only, so a deployed server
   * must list its public hostnames; the `SYRINX_ALLOWED_HOSTS` environment variable (comma-separated) adds some
   * without a code change, such as a tunnel's. Pass false to skip the check, for example behind a proxy that enforces it.
   */
  allowedHosts?: string[] | false;
  /** Hostnames browsers may call from (the Origin header). Requests without Origin pass. Defaults to localhost. */
  allowedOrigins?: string[];
  /**
   * Answer anonymous requests with 401 and a Bearer challenge, so OAuth clients know to sign in. Defaults to on under
   * `NODE_ENV=production` and off otherwise; pass false to serve anonymous callers. On without `authenticate` throws.
   */
  requireAuth?: boolean;
  /** RFC 9728 Protected Resource Metadata (and RFC 8414 passthrough), served under `/.well-known/`. */
  oauth?: AuthMetadataOptions;
  /** How 2025-era clients are served. Defaults to the SDK's stateless fallback. */
  legacy?: "stateless" | "reject";
  /**
   * Gzips JSON responses over 1 KB for clients that accept it. View shells travel inside `resources/read` results,
   * so this cuts their transfer to about a third. On by default; turn it off when a proxy in front compresses.
   */
  compress?: boolean;
}

export interface McpSurface {
  /** Serves the MCP endpoints and, with `oauth`, the well-known metadata. Other paths answer 404. */
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/** Carries the authenticated caller from the HTTP edge to the per-request server factory. */
const CALLER = `syrinx.caller`;

const jsonRpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  // -32603 is JSON-RPC's internal error; everything else refused at the edge is an invalid request.
  new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: status >= 500 ? -32603 : -32600, message } }),
    {
      status,
      headers: { "content-type": "application/json", ...headers },
    },
  );

/**
 * Every exchange is one JSON response, so the long-lived `subscriptions/listen` stream the SDK would otherwise open
 * is refused at the edge. Returns the request id when the body is a listen request.
 */
async function listenRequestId(request: Request): Promise<string | number | null | undefined> {
  if (request.method !== "POST") return undefined;
  try {
    const body = (await request.clone().json()) as { method?: unknown; id?: unknown };
    if (body.method !== "subscriptions/listen") return undefined;
    return typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
  } catch {
    return undefined; // not JSON; the SDK answers the parse error
  }
}

const methodNotFound = (id: string | number | null, method: string) =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );

/** Bodies smaller than this are sent as they are: compressing them saves less than it costs. */
const COMPRESS_MIN_BYTES = 1024;

/**
 * Public hostnames from `SYRINX_ALLOWED_HOSTS` (comma-separated), on top of localhost, so a tunnel or preview host can
 * be allowed without a code change. An explicit `allowedHosts` option wins over it.
 */
function hostsFromEnv(): string[] | undefined {
  const raw = typeof process === "undefined" ? undefined : process.env.SYRINX_ALLOWED_HOSTS;
  const extra = raw
    ?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return extra?.length ? [...localhostAllowedHostnames(), ...extra] : undefined;
}

/** The JSON-RPC method of a POST, read from a clone so the body stays for the SDK. */
async function requestMethod(request: Request): Promise<string | undefined> {
  if (request.method !== "POST") return undefined;
  try {
    const body = (await request.clone().json()) as { method?: unknown };
    return typeof body.method === "string" ? body.method : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Gzips a complete response when the client accepts gzip. JSON responses are one body, so it is buffered and its size
 * known. Clients that accept SSE too (every Streamable HTTP client must) are answered over SSE, which may stream
 * notifications mid-call, so it is left alone, except for `resources/read`: one event, never progress, and the one
 * response that is large (a view shell travels in it). Uses CompressionStream, available on Node, Bun, Deno and edge
 * runtimes.
 */
async function gzipped(request: Request, response: Response, method: string | undefined): Promise<Response> {
  const accepts = /\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "");
  const type = response.headers.get("content-type") ?? "";
  const json =
    type.startsWith("application/json") || (type.startsWith("text/event-stream") && method === "resources/read");
  if (!accepts || !json || !response.body || response.headers.has("content-encoding")) return response;
  const body = await response.arrayBuffer();
  if (body.byteLength < COMPRESS_MIN_BYTES) return new Response(body, response);
  const compressed = new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip")));
  const headers = new Headers(response.headers);
  headers.set("content-encoding", "gzip");
  headers.delete("content-length");
  headers.append("vary", "accept-encoding");
  return new Response(compressed.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * The MCP surface over Streamable HTTP: stateless, one JSON response per request, targeting 2026-07-28 with the
 * SDK's fallback for 2025-era clients. Each request gets a server built for its caller, so lists only show what
 * that caller may use.
 */
export function createMcpSurface<Deps>(options: McpOptions<Deps>): McpSurface {
  const { registry } = options;
  const logger = routineLogger(options);
  const basePath = (options.basePath ?? "/mcp").replace(/\/$/, "");
  const bypass = localAuthBypass(registry.apps.values());
  const authenticate = bypass ? () => bypass : options.authenticate;
  const requireAuth = resolveRequireAuth(options.requireAuth, authenticate !== undefined);
  checkMembers(registry, "all");
  const withViews = [...registry.apps.values()].filter((a) => Object.keys(a.views).length).map((a) => a.name);
  if (withViews.length && !options.views) {
    logger?.warn(`MCP: apps ${withViews.join(", ")} declare views, but no view shells were given; serving without UI.`);
  }
  for (const app of registry.apps.values()) {
    checkMembers(registry, { app: app.name });
    for (const warning of lintApp(app)) {
      logger?.warn(`MCP description lint: ${warning.target} ${warning.message}`, { target: warning.target });
    }
  }

  const challenge = options.oauth
    ? `Bearer resource_metadata="${getOAuthProtectedResourceMetadataUrl(options.oauth.resourceServerUrl)}"`
    : "Bearer";

  const handlers = new Map<string, McpHttpHandler>();
  const handlerFor = (scope: Scope) => {
    const key = scope === "all" ? "" : scope.app;
    let handler = handlers.get(key);
    if (!handler) {
      handler = createMcpHandler(
        ({ era, authInfo }) => buildServer(options, scope, authInfo?.extra?.[CALLER] ?? {}, { era }),
        {
          legacy: options.legacy ?? "stateless",
          responseMode: "json",
          onerror: (error) => logger?.warn("MCP request rejected", { error: String(error) }),
        },
      );
      handlers.set(key, handler);
    }
    return handler;
  };

  const scopeOf = (pathname: string): Scope | undefined => {
    if (pathname === basePath) return "all";
    if (!pathname.startsWith(`${basePath}/`)) return undefined;
    let app: string;
    try {
      app = decodeURIComponent(pathname.slice(basePath.length + 1));
    } catch {
      return undefined; // a malformed escape names no app
    }
    return registry.apps.has(app) ? { app } : undefined;
  };

  return {
    async fetch(request) {
      if (options.oauth) {
        const metadata = oauthMetadataResponse(request, options.oauth);
        if (metadata) return metadata;
      }
      const { pathname } = new URL(request.url);
      const scope = scopeOf(pathname);
      if (!scope) return jsonRpcError(404, "Not found.");
      const listen = await listenRequestId(request);
      if (listen !== undefined) return methodNotFound(listen, "subscriptions/listen");
      // Read before the SDK takes the body; only a response that may be compressed needs it.
      const method = options.compress === false ? undefined : await requestMethod(request);

      const hosts = options.allowedHosts ?? hostsFromEnv() ?? localhostAllowedHostnames();
      if (hosts !== false) {
        // Fetch-style callers may omit Host; servers build the URL from it, so the URL's host stands in.
        const host = validateHostHeader(request.headers.get("host") ?? new URL(request.url).host, hosts);
        if (!host.ok) return jsonRpcError(403, host.message);
      }
      const rejected = originValidationResponse(request, options.allowedOrigins ?? localhostAllowedOrigins());
      if (rejected) return rejected;

      let principal: Principal | undefined;
      let tenant: Tenant | undefined;
      try {
        principal = await authenticate?.(request);
        if (!principal && requireAuth) {
          return jsonRpcError(401, "Authentication required.", { "www-authenticate": challenge });
        }
        tenant = await options.resolveTenant?.(principal, request);
      } catch (error) {
        if (error instanceof SyrinxError && error.kind === "unauthenticated") {
          return jsonRpcError(401, error.message, { "www-authenticate": challenge });
        }
        logUnhandled(options.logger, error, { "syrinx.surface": "mcp", "url.path": pathname });
        return jsonRpcError(500, "Internal error");
      }
      const caller: Caller = {};
      if (principal) caller.principal = principal;
      if (tenant) caller.tenant = tenant;

      const response = await handlerFor(scope).fetch(request, {
        authInfo: {
          token: "",
          clientId: principal?.id ?? "anonymous",
          scopes: [...(principal?.scopes ?? [])],
          extra: { [CALLER]: caller },
        },
      });
      return options.compress === false ? response : gzipped(request, response, method);
    },
    async close() {
      await Promise.all([...handlers.values()].map((h) => h.close()));
      handlers.clear();
    },
  };
}
