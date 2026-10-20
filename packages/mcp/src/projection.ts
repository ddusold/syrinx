import {
  SyrinxError,
  templateVariables,
  toJsonSchema,
  isVisible,
  type App,
  type InputRequest,
  type InputRequired,
  type InvokeOptions,
  type JsonSchema,
  type Logger,
  type Operation,
  type Principal,
  type Registry,
  type Tenant,
  type Tracer,
} from "@syrinx/core";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  inputRequired,
  McpServer,
  ProtocolError,
  ResourceNotFoundError,
  ResourceTemplate,
  type CacheScope,
  type CallToolResult,
  type ElicitRequestFormParams,
  type ServerContext,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";

/** Reverse-DNS `_meta` prefix for Syrinx keys, from the project's GitHub namespace. */
export const META_PREFIX = "io.github.ddusold.syrinx";
/** Where error details travel: tool result `_meta`, or `data` on protocol errors. */
export const ERROR_META_KEY = `${META_PREFIX}/error`;
/** Set on tools whose operation may answer `input_required`, so hosts know before calling. */
export const ASKS_META_KEY = `${META_PREFIX}/asks`;

export type Era = "legacy" | "modern";

/** Who a server instance serves. HTTP builds one instance per request, so lists can be filtered per caller. */
export interface Caller {
  principal?: Principal;
  tenant?: Tenant;
}

export interface ProjectionOptions<Deps = unknown> {
  registry: Registry;
  /** Server name and version reported to clients. */
  name: string;
  version: string;
  deps?: Deps;
  logger?: Logger;
  tracer?: Tracer;
  /** How long clients may cache list results, in milliseconds. Defaults to 60 seconds. */
  listTtlMs?: number;
}

/** How the instance is served. `connected` means one long-lived connection (stdio) rather than one request. */
export interface Serving {
  era: Era;
  connected?: boolean;
}

/** One app's slice (`/mcp/{app}`, names unprefixed), or every app (`/mcp`, names prefixed with `{app}_`). */
export type Scope = { app: string } | "all";

/**
 * Publishes a JSON Schema to the SDK without letting it validate. Syrinx validates in the registry, so every surface
 * reports the same errors; letting the SDK validate first would answer bad input in its own format.
 */
const publishOnly = (schema: JsonSchema): StandardSchemaWithJSON => ({
  "~standard": {
    version: 1,
    vendor: "syrinx",
    validate: (value: unknown) => ({ value }),
    jsonSchema: { input: () => schema, output: () => schema },
  },
});

const appsIn = (registry: Registry, scope: Scope): App[] =>
  scope === "all" ? [...registry.apps.values()] : [registry.apps.get(scope.app)].filter((a) => a !== undefined);

const memberName = (app: App, name: string, scope: Scope) => (scope === "all" ? `${app.name}_${name}` : name);

export const toolName = (app: App, opName: string, operation: Operation, scope: Scope) =>
  memberName(app, operation.mcp?.name ?? opName, scope);

/** Fails fast on two operations projecting to one tool name, which the SDK would otherwise reject per request. */
export function checkToolNames(registry: Registry, scope: Scope): void {
  const seen = new Map<string, string>();
  for (const app of appsIn(registry, scope)) {
    for (const [opName, operation] of Object.entries(app.operations)) {
      if (!isVisible(operation, "model")) continue;
      const name = toolName(app, opName, operation, scope);
      const other = seen.get(name);
      if (other)
        throw new TypeError(`Operations ${other} and ${app.name}.${opName} both project to MCP tool "${name}".`);
      seen.set(name, `${app.name}.${opName}`);
    }
  }
}

const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

/**
 * Whether this client can answer questions. 2026-07-28 clients declare elicitation per request; 2025-era clients
 * declared it once at initialize. Over stateless HTTP a 2025-era client is reported as able, so it gets the clear
 * "needs a 2026-07-28 client" error rather than a silent decline.
 */
function clientCanAsk(ctx: ServerContext, server: McpServer, serving: Serving): boolean {
  // The deprecation points modern requests at the envelope; 2025-era connections only have the initialize value.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  if (serving.era === "legacy") return serving.connected ? !!server.server.getClientCapabilities()?.elicitation : true;
  const envelope = ctx.mcpReq.envelope as Record<string, { elicitation?: unknown } | undefined> | undefined;
  return !!envelope?.[CLIENT_CAPABILITIES]?.elicitation;
}

function callOptions(ctx: ServerContext, caller: Caller, options: ProjectionOptions, canAsk = true): InvokeOptions {
  const call: InvokeOptions = {
    surface: "model",
    signal: ctx.mcpReq.signal,
    requestId: String(ctx.mcpReq.id),
    canAsk,
  };
  if (options.deps !== undefined) call.deps = options.deps;
  if (options.logger) call.logger = options.logger;
  if (options.tracer) call.tracer = options.tracer;
  if (caller.principal) call.principal = caller.principal;
  if (caller.tenant) call.tenant = caller.tenant;
  const requestState = ctx.mcpReq.requestState<string>();
  if (typeof requestState === "string") {
    call.resume = { requestState, inputResponses: ctx.mcpReq.inputResponses ?? {} };
  }
  const meta = ctx.mcpReq._meta as Record<string, unknown> | undefined;
  if (typeof meta?.traceparent === "string") {
    call.traceContext = { traceparent: meta.traceparent };
    if (typeof meta.tracestate === "string") call.traceContext.tracestate = meta.tracestate;
  }
  return call;
}

const asSyrinx = (error: unknown, logger: Logger | undefined) => {
  if (error instanceof SyrinxError) return error;
  logger?.error("unexpected error on the MCP surface", { error: String(error) });
  return new SyrinxError("internal", "Internal error");
};

const details = (e: SyrinxError) => ({ kind: e.kind, message: e.message, issues: e.issues });

/**
 * Domain errors become tool results the model can read and react to, never JSON-RPC protocol errors. Details go in
 * `_meta`, not `structuredContent`: clients validate `structuredContent` against the tool's `outputSchema`, and the
 * v1 SDK client does so even for `isError` results, so an error object there fails as a schema mismatch.
 */
function toolError(e: SyrinxError): CallToolResult {
  const issues = e.issues.map((i) => `${i.path || "(root)"}: ${i.message}`);
  return {
    isError: true,
    content: [{ type: "text", text: [`${e.kind}: ${e.message}`, ...issues].join("\n") }],
    _meta: { [ERROR_META_KEY]: details(e) },
  };
}

/** Resources and prompts have no error result, so failures are protocol errors with the same details in `data`. */
function protocolError(e: SyrinxError, uri?: string): Error {
  const data = { [ERROR_META_KEY]: details(e) };
  if (e.kind === "not_found" && uri) return new ResourceNotFoundError(uri, e.message);
  if (e.kind === "validation" || e.kind === "not_found") return new ProtocolError(INVALID_PARAMS, e.message, data);
  if (e.kind === "internal") return new ProtocolError(INTERNAL_ERROR, e.message, data);
  return new ProtocolError(INVALID_REQUEST, e.message, data);
}

/** Syrinx questions become form-mode elicitations; a confirmation is a form with no fields (accept or decline). */
const elicitation = (request: InputRequest) =>
  inputRequired.elicit({
    message: request.message,
    requestedSchema: (request.kind === "ask"
      ? request.schema
      : { type: "object", properties: {} }) as ElicitRequestFormParams["requestedSchema"],
  });

/**
 * 2026-07-28 clients get an `input_required` result and retry with answers. 2025-era clients can only answer over a
 * connection that stays open: on stdio the SDK's legacy shim relays the question as an elicitation request and
 * re-runs the handler. Stateless HTTP has no such connection, so those clients get a clear tool error instead.
 */
const legacyCannotAsk = () =>
  new SyrinxError("validation", "This asks the user for input, which needs an MCP 2026-07-28 client.");

function askClient(result: InputRequired, era: Era, connected: boolean) {
  if (era === "legacy" && !connected) return toolError(legacyCannotAsk());
  return questions(result);
}

function questions(result: InputRequired) {
  return inputRequired({
    inputRequests: Object.fromEntries(Object.entries(result.inputRequests).map(([k, r]) => [k, elicitation(r)])),
    requestState: result.requestState,
  });
}

const isJson = (mimeType: string) => /^application\/(?:[\w.-]+\+)?json$/.test(mimeType);

function contents(uri: string, mimeType: string, data: unknown) {
  if (isJson(mimeType)) return { uri, mimeType, text: JSON.stringify(data) };
  if (typeof data !== "string") {
    throw new SyrinxError("internal", `A ${mimeType} resource must return a string body.`);
  }
  return mimeType.startsWith("text/") ? { uri, mimeType, text: data } : { uri, mimeType, blob: data };
}

/**
 * Builds the MCP server one caller sees: tools, resources and prompts they may use, in registry order. Members the
 * caller lacks scopes for, or that are disabled for their tenant, are left out rather than failing when called.
 */
export async function buildServer(options: ProjectionOptions, scope: Scope, caller: Caller, serving: Serving) {
  const { era, connected = false } = serving;
  const { registry, logger } = options;
  const cacheScope: CacheScope = registry.personalized ? "private" : "public";
  const list = { ttlMs: options.listTtlMs ?? 60_000, cacheScope };
  const server = new McpServer(
    { name: options.name, version: options.version },
    {
      // No streaming: clients learn about changes when they next list (guided by ttlMs), never by subscription.
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false },
      },
      cacheHints: {
        "tools/list": list,
        "prompts/list": list,
        "resources/list": list,
        "resources/templates/list": list,
        "server/discover": list,
      },
      // Forged or expired state is refused before dispatch, as the -32602 the spec asks for (SEP-2322).
      requestState: {
        verify: async (state: string) => {
          await registry.checkRequestState(state);
        },
      },
    },
  );
  const allows = (target: Parameters<Registry["allows"]>[0]) => registry.allows(target, caller);
  const completable = {
    prompts: new Map<string, { app: string; prompt: string }>(),
    resources: new Map<string, { app: string; resource: string }>(),
  };

  for (const app of appsIn(registry, scope)) {
    for (const [opName, operation] of Object.entries(app.operations)) {
      if (!isVisible(operation, "model") || !(await allows({ app: app.name, operation: opName }))) continue;
      const { annotations, mcp } = operation;
      const structured = mcp?.structured !== false;
      const meta = { ...(annotations.asks ? { [ASKS_META_KEY]: true } : {}), ...mcp?.meta };
      server.registerTool(
        toolName(app, opName, operation, scope),
        {
          ...(operation.title ? { title: operation.title } : {}),
          description: mcp?.description ?? operation.description,
          inputSchema: publishOnly(toJsonSchema(operation.input, "input")),
          ...(structured ? { outputSchema: publishOnly(toJsonSchema(operation.output, "output")) } : {}),
          annotations: {
            readOnlyHint: annotations.readOnly ?? false,
            destructiveHint: annotations.readOnly ? false : (annotations.destructive ?? true),
            idempotentHint: annotations.idempotent ?? false,
            openWorldHint: annotations.openWorld ?? false,
          },
          ...(Object.keys(meta).length ? { _meta: meta } : {}),
        },
        async (args, ctx) => {
          try {
            const call = callOptions(ctx, caller, options, clientCanAsk(ctx, server, serving));
            const result = await registry.invoke(app.name, opName, args, call);
            if (result.resultType === "input_required") return askClient(result, era, connected);
            const content = mcp?.content
              ? [...mcp.content(result.data)]
              : [{ type: "text" as const, text: JSON.stringify(result.data) }];
            return structured ? { content, structuredContent: result.data as Record<string, unknown> } : { content };
          } catch (error) {
            return toolError(asSyrinx(error, logger));
          }
        },
      );
    }

    for (const [resName, res] of Object.entries(app.resources)) {
      if (!(await allows({ app: app.name, resource: resName }))) continue;
      const mimeType = res.mimeType ?? "application/json";
      const read = async (uri: URL, variables: Record<string, unknown>, ctx: ServerContext) => {
        try {
          const data = await registry.read(app.name, resName, variables, callOptions(ctx, caller, options));
          return { contents: [contents(uri.href, mimeType, data)] };
        } catch (error) {
          throw protocolError(asSyrinx(error, logger), uri.href);
        }
      };
      const metadata = { ...(res.description ? { description: res.description } : {}), mimeType };
      const name = memberName(app, resName, scope);
      if (res.complete) completable.resources.set(res.uri, { app: app.name, resource: resName });
      if (templateVariables(res.uri).length === 0) {
        server.registerResource(name, res.uri, metadata, (uri, ctx) => read(uri, {}, ctx));
      } else {
        server.registerResource(name, new ResourceTemplate(res.uri, { list: undefined }), metadata, read);
      }
    }

    for (const [promptName, p] of Object.entries(app.prompts)) {
      if (!(await allows({ app: app.name, prompt: promptName }))) continue;
      const render = async (args: unknown, ctx: ServerContext) => {
        try {
          const call = callOptions(ctx, caller, options, clientCanAsk(ctx, server, serving));
          const rendered = await registry.render(app.name, promptName, args, call);
          if (rendered.resultType === "complete") {
            return { description: rendered.data.description, messages: rendered.data.messages };
          }
          if (era === "legacy" && !connected) throw legacyCannotAsk();
          return questions(rendered);
        } catch (error) {
          throw protocolError(asSyrinx(error, logger));
        }
      };
      const config = { ...(p.title ? { title: p.title } : {}), description: p.description };
      const name = memberName(app, p.mcp?.name ?? promptName, scope);
      if (p.args) {
        server.registerPrompt(name, { ...config, argsSchema: publishOnly(toJsonSchema(p.args, "input")) }, render);
      } else {
        server.registerPrompt(name, config, (ctx) => render({}, ctx));
      }
      if (p.complete) completable.prompts.set(name, { app: app.name, prompt: promptName });
    }
  }

  if (completable.prompts.size || completable.resources.size) {
    server.server.registerCapabilities({ completions: {} });
    server.server.setRequestHandler("completion/complete", async (request, ctx) => {
      const { ref, argument, context } = request.params;
      const target = ref.type === "ref/prompt" ? completable.prompts.get(ref.name) : completable.resources.get(ref.uri);
      // Members without completers, and unknown ones, get no suggestions rather than an error.
      if (!target) return { completion: { values: [], total: 0, hasMore: false } };
      try {
        const completion = await registry.complete(
          { ...target, argument: argument.name, value: argument.value, arguments: context?.arguments ?? {} },
          callOptions(ctx, caller, options),
        );
        return { completion };
      } catch (error) {
        throw protocolError(asSyrinx(error, logger));
      }
    });
  }
  return server;
}
