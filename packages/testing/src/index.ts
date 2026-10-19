import {
  SyrinxError,
  type ErrorKind,
  type FieldIssue,
  type InputRequest,
  type InvokeOptions,
  type Registry,
  type Resume,
} from "@syrinx/core";

/** A call's result as every surface reports it, normalized so outcomes from different surfaces compare directly. */
export type Outcome =
  | { status: "complete"; data: unknown; replayed?: true }
  | { status: "input_required"; inputRequests: Record<string, InputRequest>; requestState: string }
  | { status: "error"; kind: ErrorKind; message: string; issues: readonly FieldIssue[] };

export interface CallOptions {
  resume?: Resume;
  idempotencyKey?: string;
}

export interface SyrinxClient {
  readonly surface: string;
  invoke(app: string, operation: string, input: unknown, options?: CallOptions): Promise<Outcome>;
  read(app: string, resource: string, params: Record<string, string>): Promise<Outcome>;
}

const fromError = (error: unknown): Outcome => {
  if (!(error instanceof SyrinxError)) throw error;
  return { status: "error", kind: error.kind, message: error.message, issues: error.issues };
};

/**
 * Calls the registry directly, as the "rest" surface by default so visibility matches what HTTP clients see.
 * `defaults` sets the principal, tenant and deps for every call.
 */
export function createInProcessClient(registry: Registry, defaults: InvokeOptions = {}): SyrinxClient {
  const surface = defaults.surface ?? "rest";
  return {
    surface: `in-process:${surface}`,
    async invoke(app, operation, input, options = {}) {
      try {
        const result = await registry.invoke(app, operation, input, { surface, ...defaults, ...options });
        if (result.resultType === "input_required") {
          return { status: "input_required", inputRequests: result.inputRequests, requestState: result.requestState };
        }
        return result.replayed
          ? { status: "complete", data: result.data, replayed: true }
          : { status: "complete", data: result.data };
      } catch (error) {
        return fromError(error);
      }
    },
    async read(app, resource, params) {
      try {
        return { status: "complete", data: await registry.read(app, resource, params, { surface, ...defaults }) };
      } catch (error) {
        return fromError(error);
      }
    },
  };
}

export interface RestClientOptions {
  /** Anything fetch-shaped: a Hono app's `fetch`, a server's handler, or the global fetch. */
  fetch: (request: Request) => Response | Promise<Response>;
  baseUrl?: string;
  headers?: Record<string, string>;
}

interface Envelope {
  resultType?: string;
  data?: unknown;
  inputRequests?: Record<string, InputRequest>;
  requestState?: string;
  meta?: { replayed?: true };
  title?: string;
  detail?: string;
  errors?: FieldIssue[];
}

/** Talks to a Syrinx REST surface over HTTP semantics, without needing a real network. */
export function createRestClient({
  fetch,
  baseUrl = "http://syrinx.test",
  headers = {},
}: RestClientOptions): SyrinxClient {
  const send = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const all: Record<string, string> = { ...headers, ...extra };
    const init: RequestInit = { method, headers: all };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      all["content-type"] = "application/json";
    }
    const response = await fetch(new Request(new URL(path, baseUrl), init));
    const payload = (await response.json()) as Envelope;
    if (!response.ok) {
      return {
        status: "error",
        kind: (payload.title ?? "internal") as ErrorKind,
        message: payload.detail ?? response.statusText,
        issues: payload.errors ?? [],
      } satisfies Outcome;
    }
    if (payload.resultType === "input_required") {
      return {
        status: "input_required",
        inputRequests: payload.inputRequests ?? {},
        requestState: payload.requestState ?? "",
      } satisfies Outcome;
    }
    return payload.meta?.replayed
      ? ({ status: "complete", data: payload.data, replayed: true } satisfies Outcome)
      : ({ status: "complete", data: payload.data } satisfies Outcome);
  };

  const hrefs = new Map<string, Map<string, string>>();
  const resourceHrefs = async (app: string) => {
    const cached = hrefs.get(app);
    if (cached) return cached;
    const response = await fetch(new Request(new URL(`/api/${app}`, baseUrl), { headers }));
    const manifest = (await response.json()) as { resources?: { name: string; href?: string }[] };
    const found = new Map((manifest.resources ?? []).flatMap((r) => (r.href ? [[r.name, r.href] as const] : [])));
    hrefs.set(app, found);
    return found;
  };

  return {
    surface: "rest",
    invoke(app, operation, input, options = {}) {
      const extra: Record<string, string> = options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {};
      const path = `/api/${app}/ops/${operation}`;
      return options.resume
        ? send("POST", `${path}/resume`, { input, ...options.resume }, extra)
        : send("POST", path, input, extra);
    },
    async read(app, resource, params) {
      const href = (await resourceHrefs(app)).get(resource);
      if (!href)
        return { status: "error", kind: "not_found", message: `Unknown resource "${app}.${resource}".`, issues: [] };
      const path = href.replace(/\{([^}]+)\}/g, (_m, name: string) => encodeURIComponent(params[name] ?? ""));
      return send("GET", path);
    },
  };
}

/**
 * What must match across surfaces: data for completed calls, the questions for `input_required` (request state is
 * encrypted per call, so its bytes differ), and the kind plus field paths for errors (wording may vary by surface).
 */
function comparable(outcome: Outcome): unknown {
  switch (outcome.status) {
    case "complete":
      return { status: outcome.status, data: outcome.data };
    case "input_required":
      return { status: outcome.status, inputRequests: outcome.inputRequests };
    case "error":
      return { status: outcome.status, kind: outcome.kind, paths: outcome.issues.map((i) => i.path) };
  }
}

export interface ParityResult {
  outcomes: Record<string, Outcome>;
  /** Empty when every surface agreed; otherwise one line per surface that differs from the first. */
  differences: string[];
}

/** Runs one call on every client and reports where the surfaces disagree. */
export async function checkParity(
  clients: readonly SyrinxClient[],
  call: (client: SyrinxClient) => Promise<Outcome>,
): Promise<ParityResult> {
  const results = await Promise.all(clients.map(async (client) => [client.surface, await call(client)] as const));
  const outcomes = Object.fromEntries(results);
  const [first, ...rest] = results;
  const differences: string[] = [];
  if (first) {
    const expected = JSON.stringify(comparable(first[1]));
    for (const [surface, outcome] of rest) {
      const actual = JSON.stringify(comparable(outcome));
      if (actual !== expected) differences.push(`${surface}: ${actual} differs from ${first[0]}: ${expected}`);
    }
  }
  return { outcomes, differences };
}
