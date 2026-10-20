import {
  bindingComponent,
  bindingOp,
  schemaVersion,
  SyrinxError,
  templateVariables,
  toJsonSchema,
  isVisible,
  viewClosure,
  viewId,
  type App,
  type InputRequest,
  type InputRequired,
  type Resume,
  type InvokeOptions,
  type JsonSchema,
  type Logger,
  type Operation,
  type Principal,
  type Registry,
  type Surface,
  type Tenant,
  type Tracer,
  type View,
  type ViewBoot,
  type ViewCsp,
  type ViewResultMeta,
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
/** On bound tool results: which view renders the data, as {@link ViewResultMeta}. */
export const VIEW_META_KEY = `${META_PREFIX}/view`;
/** Views set this to "app" in `tools/call` `_meta`, so calls they make are audited as the app surface. */
export const SURFACE_META_KEY = `${META_PREFIX}/surface`;
/**
 * Views set this to true in `tools/call` `_meta` when they show questions themselves. Hosts only answer elicitations
 * during a chat turn (VS Code rejects them otherwise), so a question raised by a click in a view would be declined
 * before the user saw it. For these calls, questions come back to the view in {@link INPUT_META_KEY} instead.
 */
export const ASKS_INLINE_META_KEY = `${META_PREFIX}/asksInline`;
/** On a tool result for a view that asks inline: the questions and sealed `requestState`, as `input_required` carries them. */
export const INPUT_META_KEY = `${META_PREFIX}/input`;
/** In `tools/call` `_meta` from such a view: the answers and the echoed `requestState`. */
export const RESUME_META_KEY = `${META_PREFIX}/resume`;
/** The MCP Apps resource type (`io.modelcontextprotocol/ui`). */
export const VIEW_MIME_TYPE = "text/html;profile=mcp-app";

/** A rendered view shell: the HTML document a host loads into its sandboxed iframe. */
export interface ViewShell {
  html: string;
  /** Origins the shell needs beyond its own inline content, such as a CDN serving its hosted assets. */
  csp?: ViewCsp;
}

/** Turns a view and its boot data into a shell. `@syrinx/ui/server` builds one from the bundles `@syrinx/vite` emits. */
export interface ViewShells {
  render(view: View, boot: ViewBoot): ViewShell | Promise<ViewShell>;
}

/** The `ui://` resource a view is served at. */
export const viewUri = (v: Pick<View, "app" | "name">) => `ui://${v.app}/${v.name}`;

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
  /**
   * Built view shells. With them, views are served as `ui://{app}/{view}` resources, bound tools point at them, and
   * operations visible only to views are listed for hosts to proxy. Without them, views are left out.
   */
  views?: ViewShells;
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

/** Operations become tools when a model or a view can call them. */
const isTool = (operation: Operation) => isVisible(operation, "model") || isVisible(operation, "app");

/** Fails fast on two operations projecting to one tool name, which the SDK would otherwise reject per request. */
export function checkToolNames(registry: Registry, scope: Scope): void {
  const seen = new Map<string, string>();
  for (const app of appsIn(registry, scope)) {
    for (const [opName, operation] of Object.entries(app.operations)) {
      if (!isTool(operation)) continue;
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

function callOptions(
  ctx: ServerContext,
  caller: Caller,
  options: ProjectionOptions,
  canAsk = true,
  surface: Surface = "model",
): InvokeOptions {
  const call: InvokeOptions = {
    surface,
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

/**
 * Which surface a tool call came from. Hosts proxy view calls through the same `tools/call`, so a view marks its
 * own; an operation only views may call is the app surface either way. The mark is advisory, not a security
 * boundary: permissions apply on every surface.
 */
function surfaceOf(ctx: ServerContext, operation: Operation): Surface {
  const meta = ctx.mcpReq._meta as Record<string, unknown> | undefined;
  return meta?.[SURFACE_META_KEY] !== "app" && isVisible(operation, "model") ? "model" : "app";
}

/** True for a call from a view that shows questions itself; its questions and answers travel in `_meta`. */
function asksInline(ctx: ServerContext, surface: Surface): boolean {
  const meta = ctx.mcpReq._meta as Record<string, unknown> | undefined;
  return surface === "app" && meta?.[ASKS_INLINE_META_KEY] === true;
}

/** Answers a view sent back in `_meta`, when they are well formed; the registry checks them fully. */
function inlineResume(ctx: ServerContext): Resume | undefined {
  const meta = ctx.mcpReq._meta as Record<string, unknown> | undefined;
  const resume = meta?.[RESUME_META_KEY] as { requestState?: unknown; inputResponses?: unknown } | undefined;
  if (typeof resume?.requestState !== "string") return undefined;
  const responses = resume.inputResponses;
  return {
    requestState: resume.requestState,
    inputResponses: responses && typeof responses === "object" ? (responses as Resume["inputResponses"]) : {},
  };
}

/**
 * Questions for a view that asks inline: an ordinary tool result, so neither the host nor the SDK's legacy shim
 * intercepts it. Marked as an error so clients skip output-schema validation; the view reads `_meta` first. The
 * questions keep the `input_required` shape, and `requestState` stays sealed and bound to caller and input.
 */
function inlineQuestions(result: InputRequired): CallToolResult {
  const inputRequests = Object.fromEntries(
    Object.entries(result.inputRequests).map(([key, request]) => [
      key,
      {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: request.message,
          requestedSchema: request.kind === "ask" ? request.schema : { type: "object", properties: {} },
        },
      },
    ]),
  );
  return {
    isError: true,
    content: [{ type: "text", text: "Waiting for the user to answer in the view." }],
    _meta: { [INPUT_META_KEY]: { inputRequests, requestState: result.requestState } },
  };
}

const fingerprints = new WeakMap<Operation, Promise<string>>();
const fingerprint = (operation: Operation) => {
  let version = fingerprints.get(operation);
  if (!version) fingerprints.set(operation, (version = schemaVersion(operation)));
  return version;
};

/** Each bound operation, keyed `app.op`, with the view it renders. */
function bindings(registry: Registry) {
  const bound = new Map<string, { view: View; op: string; component?: string }>();
  for (const app of registry.apps.values()) {
    for (const v of Object.values(app.views)) {
      for (const b of v.boundTo) {
        const component = bindingComponent(b);
        bound.set(`${app.name}.${bindingOp(b)}`, { view: v, op: bindingOp(b), ...(component ? { component } : {}) });
      }
    }
  }
  return bound;
}

/**
 * What a view's shell needs: the tool name of every operation it and its embeds call or are bound to, on this
 * endpoint. Operations of apps outside the scope are left out, so calls to them fail clearly in the view.
 */
async function viewBoot(registry: Registry, root: View, scope: Scope): Promise<ViewBoot> {
  const boot: ViewBoot = { view: viewId(root), channel: "mcp", operations: {}, features: {} };
  const inScope = new Set(appsIn(registry, scope).map((a) => a.name));
  for (const v of viewClosure(root)) {
    boot.features[viewId(v)] = v.features;
    const app = registry.apps.get(v.app);
    if (!app || !inScope.has(v.app)) continue;
    const bound = new Set(v.boundTo.map(bindingOp));
    for (const opName of new Set([...v.calls, ...bound])) {
      const operation = app.operations[opName];
      if (!operation || !isTool(operation)) continue;
      boot.operations[`${v.app}.${opName}`] = {
        tool: toolName(app, opName, operation, scope),
        ...(bound.has(opName) ? { schemaVersion: await fingerprint(operation) } : {}),
      };
    }
  }
  return boot;
}

/** Origins the view declares plus those its shell needs, each list deduplicated; undefined when both are empty. */
function mergeCsp(a: ViewCsp | undefined, b: ViewCsp | undefined): Record<string, string[]> | undefined {
  const merged: Record<string, string[]> = {};
  for (const k of ["connectDomains", "resourceDomains", "frameDomains"] as const) {
    const origins = [...new Set([...(a?.[k] ?? []), ...(b?.[k] ?? [])])];
    if (origins.length) merged[k] = origins;
  }
  return Object.keys(merged).length ? merged : undefined;
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

  const { views } = options;
  const bound = views ? bindings(registry) : new Map<string, never>();

  for (const app of appsIn(registry, scope)) {
    for (const [opName, operation] of Object.entries(app.operations)) {
      // Operations only views call are listed only when views are served; without views nothing would call them.
      const listed = isVisible(operation, "model") || (views !== undefined && isVisible(operation, "app"));
      if (!listed || !(await allows({ app: app.name, operation: opName }))) continue;
      const { annotations, mcp } = operation;
      const structured = mcp?.structured !== false;
      const binding = bound.get(`${app.name}.${opName}`);
      const ui = {
        ...(binding ? { resourceUri: viewUri(binding.view) } : {}),
        ...(views && !isVisible(operation, "model") ? { visibility: ["app"] } : {}),
        ...(views && !isVisible(operation, "app") ? { visibility: ["model"] } : {}),
      };
      const meta = {
        ...(annotations.asks ? { [ASKS_META_KEY]: true } : {}),
        ...(Object.keys(ui).length ? { ui } : {}),
        ...mcp?.meta,
      };
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
            const surface = surfaceOf(ctx, operation);
            const inline = asksInline(ctx, surface);
            // A view that asks inline can always ask, whatever the client declares.
            const call = callOptions(ctx, caller, options, inline || clientCanAsk(ctx, server, serving), surface);
            const resume = inline ? inlineResume(ctx) : undefined;
            if (resume) call.resume = resume;
            const result = await registry.invoke(app.name, opName, args, call);
            if (result.resultType === "input_required") {
              return inline ? inlineQuestions(result) : askClient(result, era, connected);
            }
            const content = mcp?.content
              ? [...mcp.content(result.data)]
              : [{ type: "text" as const, text: JSON.stringify(result.data) }];
            const viewMeta: ViewResultMeta | undefined = binding && {
              view: viewId(binding.view),
              op: opName,
              ...(binding.component ? { component: binding.component } : {}),
              schemaVersion: await fingerprint(operation),
            };
            return {
              content,
              ...(structured ? { structuredContent: result.data as Record<string, unknown> } : {}),
              ...(viewMeta ? { _meta: { [VIEW_META_KEY]: viewMeta } } : {}),
            };
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

    for (const v of views ? Object.values(app.views) : []) {
      const uri = viewUri(v);
      const uiMeta = (csp: ViewCsp | undefined) => {
        const merged = mergeCsp(v.csp, csp);
        return { ui: { ...(merged ? { csp: merged } : {}), ...(v.prefersBorder ? { prefersBorder: true } : {}) } };
      };
      server.registerResource(
        memberName(app, `view-${v.name}`, scope),
        uri,
        {
          ...(v.title ? { title: v.title } : {}),
          ...(v.description ? { description: v.description } : {}),
          mimeType: VIEW_MIME_TYPE,
          _meta: uiMeta(undefined),
        },
        async () => {
          try {
            const shell = await views?.render(v, await viewBoot(registry, v, scope));
            if (!shell) throw new SyrinxError("internal", `No shell for view ${viewId(v)}.`);
            return { contents: [{ uri, mimeType: VIEW_MIME_TYPE, text: shell.html, _meta: uiMeta(shell.csp) }] };
          } catch (error) {
            throw protocolError(asSyrinx(error, logger), uri);
          }
        },
      );
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
