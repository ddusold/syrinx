import {
  bindingComponent,
  bindingOp,
  schemaVersion,
  logUnhandled,
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
  type Attributes,
  type Logger,
  type Operation,
  type Principal,
  type Registry,
  type Surface,
  type Target,
  type Tenant,
  type Tracer,
  type View,
  type ViewBoot,
  type ViewCallResult,
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
 * The tool views call operations through: `{ app, operation, input, resume? }`, visible to views only. Hosts relay a
 * view's tool calls but keep their own `_meta` (VS Code replaces it) and only show questions during a chat turn,
 * so a confirmation raised by a click would be declined unseen. Through this tool, questions come back to the view
 * as data and the view returns the answers as arguments, still checked against the sealed `requestState`.
 */
export const VIEW_CALL_TOOL = "syrinx_view_call";
/**
 * A tool that opens a view tells the model about the page it opens, in the view's own description, so a request in the
 * user's words ("change my brand settings") reaches the tool whose name alone would not say so. Only for tools a model can
 * call; app-only operations are not chosen by models.
 */
function withViewContext(description: string, view: View | undefined, forModel: boolean) {
  const about = view?.description?.trim();
  if (!view || !about || !forModel) return description;
  return `${description}\n\nOpens the "${view.title ?? view.name}" page. ${about}`;
}

/** The MCP Apps extension id hosts declare in `capabilities.extensions`. */
export const APPS_EXTENSION = "io.modelcontextprotocol/ui";
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
  /**
   * What the model should know about this server as a whole, sent to the client when it connects (MCP `instructions`):
   * the domain's terms, how its filters and ids work, rules that apply across tools. A function gets the caller, to
   * name their organization or user. Tool descriptions say what each tool does; this says how the server fits together.
   */
  instructions?: string | ((caller: Caller) => string | undefined);
  /** Server name and version reported to clients. */
  name: string;
  version: string;
  deps?: Deps;
  /**
   * Receives operation logs and internal errors (the ones callers see only as an internal error). Without it, internal
   * errors still go to console.error; `false` drops them.
   */
  logger?: Logger | false;
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

const targetKey = (t: Target) =>
  `${t.app}/${t.operation !== undefined ? `o:${t.operation}` : t.resource !== undefined ? `r:${t.resource}` : `p:${t.prompt ?? ""}`}`;

/**
 * Fails fast on what the SDK would otherwise reject on every request: two operations or prompts projecting to one
 * name, or an operation named like the view channel.
 */
export function checkMembers(registry: Registry, scope: Scope): void {
  const tools = new Map<string, string>([[VIEW_CALL_TOOL, "the view channel"]]);
  const prompts = new Map<string, string>();
  for (const app of appsIn(registry, scope)) {
    for (const [opName, operation] of Object.entries(app.operations)) {
      if (!isTool(operation)) continue;
      const name = toolName(app, opName, operation, scope);
      const other = tools.get(name);
      if (other)
        throw new TypeError(`${other} and operation ${app.name}.${opName} both project to MCP tool "${name}".`);
      tools.set(name, `Operation ${app.name}.${opName}`);
    }
    for (const [promptName, p] of Object.entries(app.prompts)) {
      const name = memberName(app, p.mcp?.name ?? promptName, scope);
      const other = prompts.get(name);
      if (other)
        throw new TypeError(`Prompts ${other} and ${app.name}.${promptName} both project to MCP prompt "${name}".`);
      prompts.set(name, `${app.name}.${promptName}`);
    }
  }
}

const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

interface ClientCapabilities {
  elicitation?: unknown;
  extensions?: Record<string, unknown>;
}

/**
 * What the client declared: 2026-07-28 clients per request, 2025-era clients once at initialize. Undefined for a
 * 2025-era client over stateless HTTP, where the initialize declaration is not kept.
 */
function clientCapabilities(ctx: ServerContext, server: McpServer, serving: Serving): ClientCapabilities | undefined {
  if (serving.era === "legacy") {
    if (!serving.connected) return undefined;
    // The deprecation points modern requests at the envelope; 2025-era connections only have the initialize value.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return (server.server.getClientCapabilities() as ClientCapabilities | undefined) ?? {};
  }
  const envelope = ctx.mcpReq.envelope as Record<string, ClientCapabilities | undefined> | undefined;
  return envelope?.[CLIENT_CAPABILITIES] ?? {};
}

/**
 * Whether this client can answer questions. A 2025-era client over stateless HTTP is reported as able, so it gets
 * the clear "needs a 2026-07-28 client" error rather than a silent decline.
 */
function clientCanAsk(ctx: ServerContext, server: McpServer, serving: Serving): boolean {
  const declared = clientCapabilities(ctx, server, serving);
  return declared === undefined || !!declared.elicitation;
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

/** The logger for routine output; `logger: false` silences it along with unhandled errors. */
export const routineLogger = (options: Pick<ProjectionOptions, "logger">) =>
  options.logger === false ? undefined : options.logger;

/**
 * The error the client sees, after logging internal ones. Takes the options rather than a logger so `logger: false`
 * cannot be lost on the way to logUnhandled.
 */
const asSyrinx = (
  error: unknown,
  options: Pick<ProjectionOptions, "logger">,
  ctx: ServerContext | undefined,
  attributes: Attributes,
) => {
  if (error instanceof SyrinxError && error.kind !== "internal") return error;
  logUnhandled(options.logger, error, {
    "syrinx.surface": "mcp",
    ...(ctx ? { "syrinx.request_id": String(ctx.mcpReq.id) } : {}),
    ...attributes,
  });
  return error instanceof SyrinxError ? error : new SyrinxError("internal", "Internal error");
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

const modernCannotAsk = () =>
  new SyrinxError("validation", "This asks the user for input, which needs a client that supports elicitation.");

function askClient(result: InputRequired, era: Era, connected: boolean, canElicit: boolean) {
  const stateless = era === "legacy" && !connected;
  if (stateless || !canElicit) {
    // Plain stateless HTTP cannot carry an elicitation, and a 2026-07-28 client may not declare it. A confirmation can
    // still be answered by the user, through the model: the call ends here with the question and a token, and goes
    // through when it is repeated with the token. Questions that collect a value have no such fallback.
    const questions = Object.values(result.inputRequests);
    if (questions.length > 0 && questions.every((q) => q.kind === "confirm")) return confirmationRequired(result);
    return toolError(stateless ? legacyCannotAsk() : modernCannotAsk());
  }
  return questions(result);
}

/** The name of the argument a confirmation is answered with when the client cannot be asked directly. */
export const CONFIRMATION_TOKEN_ARG = "confirmationToken";

/**
 * A call that stopped for the user's confirmation. It is an error result so nothing reads it as done (and, as with other
 * errors, it carries no structured content for the tool's output schema to reject); the text tells the model to ask the
 * user and how to go ahead. The token is the call's sealed request state: it expires, belongs to this caller and these
 * exact arguments, and answers one question.
 */
function confirmationRequired(result: InputRequired): CallToolResult {
  const messages = Object.values(result.inputRequests).map((q) => q.message);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: [
          "Nothing has been changed: this needs the user's confirmation first.",
          "",
          ...messages.map((m) => `Confirm with the user: ${m}`),
          "",
          `Show the user exactly what will happen and ask whether to go ahead. Only if they agree, call this tool again with the same arguments and \`${CONFIRMATION_TOKEN_ARG}\` set to the value below. Never set it without the user's yes; if they decline, stop.`,
          "",
          `${CONFIRMATION_TOKEN_ARG}: ${result.requestState}`,
        ].join("\n"),
      },
    ],
    _meta: { [ERROR_META_KEY]: { kind: "confirmation_required", message: messages.join(" "), issues: [] } },
  };
}

/** Answers every question "accept": for a call repeated with a confirmation token, whose questions are all confirmations. */
const acceptAll = (): Record<string, unknown> => new Proxy({}, { get: () => ({ action: "accept" }), has: () => true });

/** The tool's input schema, with the confirmation token added when the operation asks. */
function withConfirmationArg(schema: JsonSchema): JsonSchema {
  const base = schema as { type?: string; properties?: Record<string, unknown> };
  if (base.type !== "object") return schema;
  return {
    ...schema,
    properties: {
      ...base.properties,
      [CONFIRMATION_TOKEN_ARG]: {
        type: "string",
        description:
          "Only after the user has confirmed: the token a previous call returned when it asked for confirmation. Never invent or reuse one.",
      },
    },
  };
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

/**
 * Whether the client may be an MCP Apps host. Clients that declare what they support must declare the extension;
 * a 2025-era client over stateless HTTP cannot be asked, so the view token alone decides.
 */
function clientMayBeAppsHost(ctx: ServerContext, server: McpServer, serving: Serving): boolean {
  const declared = clientCapabilities(ctx, server, serving);
  return declared === undefined || !!declared.extensions?.[APPS_EXTENSION];
}

function viewCallResult(result: ViewCallResult): CallToolResult {
  return {
    ...(result.resultType === "error" ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

/** Questions in the `input_required` shape, as embedded elicitation requests. */
const asElicitations = (result: InputRequired) =>
  Object.fromEntries(
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

const viewCallSchema: JsonSchema = {
  type: "object",
  properties: {
    app: { type: "string", description: "The app that owns the operation." },
    token: { type: "string", description: "The view token from the view's boot." },
    operation: { type: "string", description: "The operation to call; it must be visible to views." },
    input: { type: "object", description: "The operation's input." },
    resume: {
      type: "object",
      description: "Answers to the questions of an earlier call, with its requestState echoed.",
      properties: { requestState: { type: "string" }, inputResponses: { type: "object" } },
      required: ["requestState"],
    },
  },
  required: ["app", "operation", "token"],
};

const fingerprints = new WeakMap<Operation, Promise<string>>();
const fingerprint = (operation: Operation) => {
  let version = fingerprints.get(operation);
  if (!version) fingerprints.set(operation, (version = schemaVersion(operation)));
  return version;
};

interface Binding {
  view: View;
  op: string;
  component?: string;
}

const bindingsByRegistry = new WeakMap<Registry, Map<string, Binding>>();

/** Each bound operation, keyed `app.op`, with the view it renders. Registries are fixed, so this is computed once. */
function bindings(registry: Registry) {
  const cached = bindingsByRegistry.get(registry);
  if (cached) return cached;
  const bound = new Map<string, Binding>();
  for (const app of registry.apps.values()) {
    for (const v of Object.values(app.views)) {
      for (const b of v.boundTo) {
        const component = bindingComponent(b);
        bound.set(`${app.name}.${bindingOp(b)}`, { view: v, op: bindingOp(b), ...(component ? { component } : {}) });
      }
    }
  }
  bindingsByRegistry.set(registry, bound);
  return bound;
}

const viewMetaFor = async (binding: Binding, op: string, operation: Operation): Promise<ViewResultMeta> => ({
  view: viewId(binding.view),
  op,
  ...(binding.component ? { component: binding.component } : {}),
  schemaVersion: await fingerprint(operation),
});

/**
 * How a view and its embeds reach operations on this endpoint, keyed `app.op`: a tool for each operation they call
 * or are bound to that views may call, and the output fingerprint of each bound one. Operations of apps outside
 * the scope are left out, so calls to them fail clearly in the view.
 */
async function viewRoutes(registry: Registry, root: View, scope: Scope): Promise<ViewBoot["operations"]> {
  const routes: ViewBoot["operations"] = {};
  const inScope = new Set(appsIn(registry, scope).map((a) => a.name));
  for (const v of viewClosure(root)) {
    const app = registry.apps.get(v.app);
    if (!app || !inScope.has(v.app)) continue;
    const bound = new Set(v.boundTo.map(bindingOp));
    for (const opName of new Set([...v.calls, ...bound])) {
      const operation = app.operations[opName];
      if (!operation || !isTool(operation)) continue;
      routes[`${v.app}.${opName}`] = {
        ...(isVisible(operation, "app") ? { tool: toolName(app, opName, operation, scope) } : {}),
        ...(bound.has(opName) ? { schemaVersion: await fingerprint(operation) } : {}),
      };
    }
  }
  return routes;
}

/**
 * What a view's shell needs: its routes, its features, and, when the registry can mint one, the view channel with
 * a token for this caller. Without a token the view calls tools directly and the host does any asking.
 */
async function viewBoot(registry: Registry, root: View, scope: Scope, caller: Caller): Promise<ViewBoot> {
  const boot: ViewBoot = {
    view: viewId(root),
    channel: "mcp",
    operations: await viewRoutes(registry, root, scope),
    features: Object.fromEntries(viewClosure(root).map((v) => [viewId(v), v.features])),
    ...(root.hostStyles ? { hostStyles: root.hostStyles } : {}),
  };
  const token = await registry.mintViewToken(viewId(root), caller);
  if (token) Object.assign(boot, { viewCallTool: VIEW_CALL_TOOL, viewToken: token });
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

/** The view channel stands for every operation views may call, so its hints are the most cautious among them. */
function channelAnnotations(registry: Registry, scope: Scope) {
  const ops = appsIn(registry, scope).flatMap((app) =>
    Object.values(app.operations).filter((operation) => isVisible(operation, "app")),
  );
  const readOnly = ops.every((o) => o.annotations.readOnly === true);
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && ops.some((o) => !o.annotations.readOnly && (o.annotations.destructive ?? true)),
    idempotentHint: ops.every((o) => o.annotations.idempotent === true),
    openWorldHint: ops.some((o) => o.annotations.openWorld === true),
  };
}

const channelUnavailable = (message: string) =>
  viewCallResult({ resultType: "error", error: { kind: "unavailable", message } });

/**
 * Registers {@link VIEW_CALL_TOOL}: views call operations through it and get questions back as data. Answers travel
 * as arguments, so a call must carry the view token from the shell, which models never see in tool results, and
 * the client must not have declared itself something other than an MCP Apps host.
 */
function registerViewChannel(
  server: McpServer,
  options: ProjectionOptions,
  scope: Scope,
  caller: Caller,
  serving: Serving,
  bound: Map<string, Binding>,
) {
  const { registry } = options;
  const logger = routineLogger(options);
  server.registerTool(
    VIEW_CALL_TOOL,
    {
      title: "View call",
      description: "Calls an operation on behalf of a view. Only views use this tool.",
      inputSchema: publishOnly(viewCallSchema),
      annotations: channelAnnotations(registry, scope),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args, ctx) => {
      const { app, operation, input, token, resume } = args as {
        app?: unknown;
        operation?: unknown;
        input?: unknown;
        token?: unknown;
        resume?: { requestState?: unknown; inputResponses?: unknown };
      };
      try {
        logger?.debug("MCP view call", { app: String(app), operation: String(operation) });
        if (typeof token !== "string" || !clientMayBeAppsHost(ctx, server, serving)) {
          return channelUnavailable("Only views served by an MCP Apps host may use the view channel.");
        }
        let viewName: string;
        try {
          viewName = await registry.openViewToken(token, caller);
        } catch {
          // Expired or foreign: the view falls back to calling tools directly, where the host does the asking.
          return channelUnavailable("The view token is not valid here; call the operation's tool instead.");
        }
        const [viewApp = "", name = ""] = viewName.split("/");
        const root = registry.getView(viewApp, name);
        const route = root && (await viewRoutes(registry, root, scope))[`${String(app)}.${String(operation)}`];
        if (typeof app !== "string" || typeof operation !== "string" || !route?.tool) {
          throw new SyrinxError("not_found", `Unknown operation "${String(app)}.${String(operation)}".`);
        }
        const call = callOptions(ctx, caller, options, true, "app");
        if (resume !== undefined) {
          if (typeof resume.requestState !== "string") {
            throw new SyrinxError("validation", "resume needs the requestState of the call it answers.", [
              { path: "resume.requestState", message: "Required." },
            ]);
          }
          const responses = resume.inputResponses;
          call.resume = {
            requestState: resume.requestState,
            inputResponses: responses && typeof responses === "object" ? (responses as Resume["inputResponses"]) : {},
          };
        }
        const result = await registry.invoke(app, operation, input ?? {}, call);
        if (result.resultType === "input_required") {
          return viewCallResult({
            resultType: "input_required",
            inputRequests: asElicitations(result),
            requestState: result.requestState,
          });
        }
        const binding = bound.get(`${app}.${operation}`);
        const target = registry.get(app, operation);
        const view = binding && target ? await viewMetaFor(binding, operation, target) : undefined;
        return viewCallResult({ resultType: "complete", data: result.data, ...(view ? { view } : {}) });
      } catch (error) {
        const e = asSyrinx(error, options, ctx, {
          "syrinx.surface": "app",
          "syrinx.app": String(app),
          "syrinx.operation": String(operation),
        });
        return viewCallResult({ resultType: "error", error: details(e) });
      }
    },
  );
}

/**
 * Builds the MCP server one caller sees: tools, resources and prompts they may use, in registry order. Members the
 * caller lacks scopes for, or that are disabled for their tenant, are left out rather than failing when called.
 */
export async function buildServer(options: ProjectionOptions, scope: Scope, caller: Caller, serving: Serving) {
  const { era, connected = false } = serving;
  const { registry } = options;
  const logger = routineLogger(options);
  const cacheScope: CacheScope = registry.personalized ? "private" : "public";
  const list = { ttlMs: options.listTtlMs ?? 60_000, cacheScope };
  const instructions = typeof options.instructions === "function" ? options.instructions(caller) : options.instructions;
  const server = new McpServer(
    { name: options.name, version: options.version },
    {
      ...(instructions ? { instructions } : {}),
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
  const apps = appsIn(registry, scope);
  // Checked together up front: isEnabled may be a lookup, and a request should not wait on each in turn.
  const targets: Target[] = apps.flatMap((app) => [
    ...Object.keys(app.operations).map((operation) => ({ app: app.name, operation })),
    ...Object.keys(app.resources).map((resource) => ({ app: app.name, resource })),
    ...Object.keys(app.prompts).map((prompt) => ({ app: app.name, prompt })),
  ]);
  const verdicts = await Promise.all(targets.map((t) => registry.allows(t, caller)));
  const allowed = new Set(targets.filter((_t, i) => verdicts[i]).map(targetKey));
  const allows = (target: Target) => allowed.has(targetKey(target));
  const completable = {
    prompts: new Map<string, { app: string; prompt: string }>(),
    resources: new Map<string, { app: string; resource: string }>(),
  };

  const { views } = options;
  const bound = views ? bindings(registry) : new Map<string, never>();

  for (const app of apps) {
    for (const [opName, operation] of Object.entries(app.operations)) {
      // Operations only views call are listed only when views are served; without views nothing would call them.
      const listed = isVisible(operation, "model") || (views !== undefined && isVisible(operation, "app"));
      if (!listed || !allows({ app: app.name, operation: opName })) continue;
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
          description: withViewContext(
            mcp?.description ?? operation.description,
            binding?.view,
            isVisible(operation, "model"),
          ),
          inputSchema: publishOnly(
            annotations.asks
              ? withConfirmationArg(toJsonSchema(operation.input, "input"))
              : toJsonSchema(operation.input, "input"),
          ),
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
            logger?.debug("MCP tool call", { tool: toolName(app, opName, operation, scope), surface });
            const canElicit = clientCanAsk(ctx, server, serving);
            // A 2026-07-28 client that cannot elicit still gets the question, as a confirmation token for the model
            // to relay; declining it unseen (canAsk false) would leave the model with an error and no way forward.
            const call = callOptions(ctx, caller, options, canElicit || era !== "legacy", surface);
            let input: unknown = args;
            if (annotations.asks && args && typeof args === "object" && CONFIRMATION_TOKEN_ARG in args) {
              // A repeat of a call that asked for confirmation: the token is not part of the input it was minted for.
              const { [CONFIRMATION_TOKEN_ARG]: token, ...rest } = args as Record<string, unknown>;
              input = rest;
              if (typeof token === "string" && token)
                call.resume = { requestState: token, inputResponses: acceptAll() };
            }
            const result = await registry.invoke(app.name, opName, input, call);
            if (result.resultType === "input_required") return askClient(result, era, connected, canElicit);
            const content = mcp?.content
              ? [...mcp.content(result.data)]
              : [{ type: "text" as const, text: JSON.stringify(result.data) }];
            const viewMeta = binding && (await viewMetaFor(binding, opName, operation));
            return {
              content,
              ...(structured ? { structuredContent: result.data as Record<string, unknown> } : {}),
              ...(viewMeta ? { _meta: { [VIEW_META_KEY]: viewMeta } } : {}),
            };
          } catch (error) {
            return toolError(asSyrinx(error, options, ctx, { "syrinx.app": app.name, "syrinx.operation": opName }));
          }
        },
      );
    }

    for (const [resName, res] of Object.entries(app.resources)) {
      if (!allows({ app: app.name, resource: resName })) continue;
      const mimeType = res.mimeType ?? "application/json";
      const read = async (uri: URL, variables: Record<string, unknown>, ctx: ServerContext) => {
        try {
          const data = await registry.read(app.name, resName, variables, callOptions(ctx, caller, options));
          return { contents: [contents(uri.href, mimeType, data)] };
        } catch (error) {
          throw protocolError(
            asSyrinx(error, options, ctx, { "syrinx.app": app.name, "syrinx.resource": resName }),
            uri.href,
          );
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
            const shell = await views?.render(v, await viewBoot(registry, v, scope, caller));
            if (!shell) throw new SyrinxError("internal", `No shell for view ${viewId(v)}.`);
            return { contents: [{ uri, mimeType: VIEW_MIME_TYPE, text: shell.html, _meta: uiMeta(shell.csp) }] };
          } catch (error) {
            throw protocolError(
              asSyrinx(error, options, undefined, { "syrinx.app": app.name, "syrinx.view": v.name }),
              uri,
            );
          }
        },
      );
    }

    for (const [promptName, p] of Object.entries(app.prompts)) {
      if (!allows({ app: app.name, prompt: promptName })) continue;
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
          throw protocolError(asSyrinx(error, options, ctx, { "syrinx.app": app.name, "syrinx.prompt": promptName }));
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

  if (views) registerViewChannel(server, options, scope, caller, serving, bound);

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
        throw protocolError(asSyrinx(error, options, ctx, { "syrinx.app": target.app }));
      }
    });
  }
  return server;
}
