import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ERROR_META_KEY } from "@syrinx/mcp";
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
  /** Renders a prompt; a complete outcome's data is `{ description, messages }`. */
  render(
    app: string,
    prompt: string,
    args?: Record<string, string>,
    options?: Pick<CallOptions, "resume">,
  ): Promise<Outcome>;
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
    async render(app, prompt, args = {}, options = {}) {
      try {
        const result = await registry.render(app, prompt, args, { surface, ...defaults, ...options });
        if (result.resultType === "input_required") {
          return { status: "input_required", inputRequests: result.inputRequests, requestState: result.requestState };
        }
        return { status: "complete", data: result.data };
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
    render(app, prompt, args = {}, options = {}) {
      const path = `/api/${app}/prompts/${prompt}`;
      return options.resume
        ? send("POST", `${path}/resume`, { input: args, ...options.resume })
        : send("POST", path, args);
    },
  };
}

export interface McpClientOptions {
  /** Anything fetch-shaped that serves the MCP surface, such as a Hono app's `fetch`. */
  fetch: (request: Request) => Response | Promise<Response>;
  baseUrl?: string;
  /** Where the MCP endpoints live. Each app is reached at `{basePath}/{app}`, so names carry no app prefix. */
  basePath?: string;
  headers?: Record<string, string>;
  /** The registry being served, so operations and prompts renamed with `mcp.name` are called by their MCP names. */
  registry?: Pick<Registry, "get" | "getPrompt">;
}

interface ErrorDetails {
  kind?: ErrorKind;
  message?: string;
  issues?: FieldIssue[];
}

interface ElicitationRequest {
  method?: string;
  params?: { message?: string; requestedSchema?: { properties?: Record<string, unknown> } & Record<string, unknown> };
}

/** Elicitations back to Syrinx questions: a form with no fields is a confirmation. */
function toInputRequest(request: ElicitationRequest): InputRequest {
  const message = request.params?.message ?? "";
  const schema = request.params?.requestedSchema;
  return schema && Object.keys(schema.properties ?? {}).length
    ? { kind: "ask", message, schema }
    : { kind: "confirm", message };
}

/** An MCP `input_required` result as an outcome, with elicitations turned back into Syrinx questions. */
function questionsOf(result: Record<string, unknown>): Outcome {
  const requests = (result.inputRequests ?? {}) as Record<string, ElicitationRequest>;
  return {
    status: "input_required",
    inputRequests: Object.fromEntries(Object.entries(requests).map(([k, r]) => [k, toInputRequest(r)])),
    requestState: typeof result.requestState === "string" ? result.requestState : "",
  };
}

const errorOf = (details: ErrorDetails | undefined, fallback: string): Outcome => ({
  status: "error",
  kind: details?.kind ?? "internal",
  message: details?.message ?? fallback,
  issues: details?.issues ?? [],
});

/**
 * Talks to a Syrinx MCP surface as a 2026-07-28 client, with input round trips left to the caller (manual mode) so
 * `input_required` outcomes compare directly with REST.
 */
export function createMcpClient({
  fetch,
  baseUrl = "http://localhost",
  basePath = "/mcp",
  headers = {},
  registry,
}: McpClientOptions): SyrinxClient & { close(): Promise<void> } {
  const clients = new Map<string, Promise<Client>>();
  const connect = (app: string) => {
    let client = clients.get(app);
    if (!client) {
      const transport = new StreamableHTTPClientTransport(new URL(`${basePath}/${app}`, baseUrl), {
        fetch: async (url, init) => fetch(new Request(url, init)),
        requestInit: { headers },
      });
      const created = new Client(
        { name: "syrinx-testing", version: "0.0.0" },
        {
          versionNegotiation: { mode: "auto" },
          capabilities: { elicitation: {} },
          inputRequired: { autoFulfill: false },
        },
      );
      client = created.connect(transport).then(() => created);
      clients.set(app, client);
    }
    return client;
  };

  const templates = new Map<string, Promise<Map<string, string>>>();
  const resourceUris = (app: string) => {
    let found = templates.get(app);
    if (!found) {
      found = connect(app).then(async (client) => {
        const [fixed, templated] = await Promise.all([client.listResources(), client.listResourceTemplates()]);
        return new Map([
          ...fixed.resources.map((r) => [r.name, r.uri] as const),
          ...templated.resourceTemplates.map((r) => [r.name, r.uriTemplate] as const),
        ]);
      });
      templates.set(app, found);
    }
    return found;
  };

  return {
    surface: "mcp",
    async invoke(app, operation, input, options = {}) {
      const client = await connect(app);
      const name = registry?.get(app, operation)?.mcp?.name ?? operation;
      const params: Record<string, unknown> = { name, arguments: input ?? {} };
      if (options.resume) {
        params.requestState = options.resume.requestState;
        params.inputResponses = options.resume.inputResponses;
      }
      let result: Record<string, unknown>;
      try {
        result = await client.callTool(params as Parameters<Client["callTool"]>[0], {
          allowInputRequired: true,
        });
      } catch (error) {
        // Hidden and unknown tools are protocol errors; the caller sees the same thing as for a missing operation.
        const data = (error as { data?: Record<string, ErrorDetails> }).data;
        return errorOf(data?.[ERROR_META_KEY] ?? { kind: "not_found" }, String(error));
      }
      if (result.resultType === "input_required") return questionsOf(result);
      if (result.isError) {
        const meta = result._meta as Record<string, ErrorDetails> | undefined;
        return errorOf(meta?.[ERROR_META_KEY], "Tool error");
      }
      return { status: "complete", data: result.structuredContent };
    },
    async read(app, resource, params) {
      const template = (await resourceUris(app)).get(resource);
      if (!template)
        return { status: "error", kind: "not_found", message: `Unknown resource "${app}.${resource}".`, issues: [] };
      const uri = template.replace(/\{([^}]+)\}/g, (_m, name: string) => encodeURIComponent(params[name] ?? ""));
      try {
        const { contents } = await (await connect(app)).readResource({ uri });
        const first = contents[0] as { text?: string; mimeType?: string } | undefined;
        const json = first?.mimeType === undefined || first.mimeType.endsWith("json");
        return { status: "complete", data: first?.text !== undefined && json ? JSON.parse(first.text) : first?.text };
      } catch (error) {
        const data = (error as { data?: Record<string, ErrorDetails> }).data;
        return errorOf(data?.[ERROR_META_KEY] ?? { kind: "not_found" }, String(error));
      }
    },
    async render(app, prompt, args = {}, options = {}) {
      try {
        const name = registry?.getPrompt(app, prompt)?.mcp?.name ?? prompt;
        const params: Record<string, unknown> = { name, arguments: args };
        if (options.resume) {
          params.requestState = options.resume.requestState;
          params.inputResponses = options.resume.inputResponses;
        }
        const result = (await (
          await connect(app)
        ).getPrompt(params as Parameters<Client["getPrompt"]>[0], { allowInputRequired: true })) as Record<
          string,
          unknown
        >;
        if (result.resultType === "input_required") return questionsOf(result);
        return { status: "complete", data: { description: result.description, messages: result.messages } };
      } catch (error) {
        const data = (error as { data?: Record<string, ErrorDetails> }).data;
        return errorOf(data?.[ERROR_META_KEY] ?? { kind: "not_found" }, String(error));
      }
    },
    async close() {
      const all = await Promise.all(clients.values());
      clients.clear();
      await Promise.all(all.map((c) => c.close()));
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
