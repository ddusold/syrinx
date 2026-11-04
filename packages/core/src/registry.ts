import {
  templateVariables,
  type App,
  type Completer,
  type Operation,
  type Permissions,
  type Prompt,
  type Resource,
} from "./app.js";
import { toMessages, type RenderedPrompt } from "./content.js";
import {
  anonymous,
  noopLogger,
  noopTracer,
  type Attributes,
  type Context,
  type Logger,
  type Principal,
  type Surface,
  type Tenant,
  type TraceContext,
  type Tracer,
} from "./context.js";
import { canonicalJson, sha256, type Secret } from "./crypto.js";
import { errors, SyrinxError, toFieldIssues, type ErrorKind, type FieldIssue } from "./errors.js";
import type { IdempotencyStore } from "./idempotency.js";
import {
  createAsker,
  createRequestStateCodec,
  createViewTokenCodec,
  InputRequiredSignal,
  type Binding,
  type InputRequired,
  type RequestStateCodec,
  type Resume,
  type ViewTokenCodec,
} from "./interaction.js";
import type { StandardSchemaV1 } from "./standard-schema.js";
import type { View } from "./view.js";

export interface InvokeOptions<Deps = unknown> {
  deps?: Deps;
  principal?: Principal;
  tenant?: Tenant;
  /** The surface the call came in on. Operations not visible there are reported as not found. Omit for in-process calls. */
  surface?: Surface;
  requestId?: string;
  /** Deduplicates writes when the registry has an idempotency store. Ignored for read-only operations. */
  idempotencyKey?: string;
  /** Answers to an earlier `input_required` result. */
  resume?: Resume;
  /** False when the caller cannot answer questions, so ctx.confirm / ctx.ask resolve as declined. Defaults to true. */
  canAsk?: boolean;
  signal?: AbortSignal;
  logger?: Logger;
  tracer?: Tracer;
  traceContext?: TraceContext;
}

export interface AuditRecord {
  at: string;
  durationMs: number;
  requestId: string;
  surface: Surface | "in-process";
  app: string;
  operation: string;
  principal: string;
  tenant: string | undefined;
  idempotencyKey: string | undefined;
  /** Shared by every round of one call: the `input_required` rounds and the round that finishes it. */
  interactionId: string;
  outcome: "complete" | "replayed" | "input_required" | ErrorKind;
}

export interface RegistryOptions {
  /**
   * Secret (at least 32 bytes) that encrypts `requestState`; required for operations that ask for input. Pass a list to
   * rotate: the first key seals new state and every key in the list still opens state sealed earlier.
   */
  requestStateKey?: Secret | readonly Secret[];
  /** How long an `input_required` answer window stays open. Defaults to 600 seconds. */
  requestStateTtlSeconds?: number;
  /** How long a view token, minted when a view's shell is served, stays valid. Defaults to 86400 seconds (a day). */
  viewTokenTtlSeconds?: number;
  /** Where Idempotency-Key outcomes are kept. Without one, keys are passed to handlers but nothing is deduplicated. */
  idempotency?: IdempotencyStore;
  /** Receives one record per write (non-read-only operation), whatever the outcome. */
  audit?: (record: AuditRecord) => void | Promise<void>;
  /** Tenant enablement. Disabled apps, operations and resources are reported as not found. */
  isEnabled?: (target: Target, tenant: Tenant | undefined) => boolean | Promise<boolean>;
}

/** One member of an app, as tenant enablement and listing see it. */
export interface Target {
  app: string;
  operation?: string;
  resource?: string;
  prompt?: string;
}

export type InvokeResult = { resultType: "complete"; data: unknown; replayed?: true } | InputRequired;

export type RenderResult = { resultType: "complete"; data: RenderedPrompt } | InputRequired;

/** A suggestion request for one prompt argument or resource template variable, as MCP's completion/complete. */
export interface CompletionRequest {
  app: string;
  prompt?: string;
  resource?: string;
  argument: string;
  value: string;
  /** Arguments already filled in, for completers that depend on them. */
  arguments?: Record<string, string>;
}

/** At most this many suggestions are returned, as MCP allows. */
const MAX_COMPLETIONS = 100;

export interface Registry {
  readonly apps: ReadonlyMap<string, App>;
  get(app: string, operation: string): Operation | undefined;
  getResource(app: string, resource: string): Resource | undefined;
  getPrompt(app: string, prompt: string): Prompt | undefined;
  getView(app: string, view: string): View | undefined;
  /**
   * Whether a caller would see this member in a listing: enabled for the tenant and, when it declares scopes, held
   * by the principal. Predicates need input, so they are checked only when the member is called.
   */
  allows(target: Target, options?: Pick<InvokeOptions, "principal" | "tenant">): Promise<boolean>;
  /** True when listings can differ between callers (scopes or tenant enablement), so they must not be shared. */
  readonly personalized: boolean;
  invoke(app: string, operation: string, input: unknown, options?: InvokeOptions): Promise<InvokeResult>;
  read(app: string, resource: string, params: Record<string, unknown>, options?: InvokeOptions): Promise<unknown>;
  /** Renders a prompt. Prompts that declare `asks` may answer `input_required`, resumed like operations. */
  render(app: string, prompt: string, args: unknown, options?: InvokeOptions): Promise<RenderResult>;
  /** Suggestions for a prompt argument or resource template variable; empty when the member has no completer. */
  complete(
    request: CompletionRequest,
    options?: InvokeOptions,
  ): Promise<{ values: string[]; total: number; hasMore: boolean }>;
  /**
   * Rejects a `requestState` this registry did not mint, or that has expired, with a validation error. Calls still
   * check it fully (binding included); this lets a surface refuse forged state before dispatching anything.
   */
  checkRequestState(requestState: string): Promise<void>;
  /**
   * Seals which view (`app/view`) a shell was served for, and to whom. Surfaces put it in the view's boot and
   * require it on calls only views may make. Undefined when the registry has no requestStateKey.
   */
  mintViewToken(view: string, options?: Pick<InvokeOptions, "principal" | "tenant">): Promise<string | undefined>;
  /**
   * The view a token was minted for. Rejects forged and expired tokens, and tokens minted for another principal or
   * tenant, with a validation error.
   */
  openViewToken(token: string, options?: Pick<InvokeOptions, "principal" | "tenant">): Promise<string>;
}

export function isVisible(operation: Operation, surface: Surface): boolean {
  return operation.visibility.includes(surface);
}

const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record && Object.hasOwn(record, key) ? record[key] : undefined;

const withAttributes = (logger: Logger, base: Attributes): Logger => ({
  debug: (message, attributes) => {
    logger.debug(message, { ...base, ...attributes });
  },
  info: (message, attributes) => {
    logger.info(message, { ...base, ...attributes });
  },
  warn: (message, attributes) => {
    logger.warn(message, { ...base, ...attributes });
  },
  error: (message, attributes) => {
    logger.error(message, { ...base, ...attributes });
  },
});

const isAnonymous = (principal: Principal) => principal === anonymous || principal.id === anonymous.id;

const denied = (principal: Principal, what: string) =>
  isAnonymous(principal) ? errors.unauthenticated(`${what} requires authentication.`) : errors.forbidden();

const holdsScopes = (permissions: Permissions<never> | undefined, principal: Principal) =>
  !permissions || typeof permissions === "function" || permissions.every((s) => principal.scopes.includes(s));

/** Scopes are checked before validation; predicates need the validated input, so they run after it. */
function checkScopes(permissions: Permissions<never> | undefined, principal: Principal, what: string) {
  if (!holdsScopes(permissions, principal)) throw denied(principal, what);
}

async function checkPredicate<I>(
  permissions: Permissions<I> | undefined,
  principal: Principal,
  input: I,
  what: string,
) {
  if (typeof permissions === "function" && !(await permissions(principal, input))) throw denied(principal, what);
}

type Asker = ReturnType<typeof createAsker>;

/** For code that must not ask: resources, and operations that do not declare `annotations.asks`. */
const refuseAsking = (message: string): Asker => ({
  answers: [],
  confirm: () => Promise.reject(new SyrinxError("internal", message)),
  ask: () => Promise.reject(new SyrinxError("internal", message)),
});

async function perform(operation: Operation, input: unknown, ctx: Context): Promise<unknown> {
  const question = await operation.confirm?.(input, ctx);
  if (question !== undefined && !(await ctx.confirm(question))) {
    throw errors.cancelled(
      ctx.canAsk ? "Declined by the caller." : "This needs the user's confirmation, but the client cannot ask for it.",
    );
  }
  return operation.handler(input, ctx);
}

/** Builds the context, wraps the call in a span, and validates output. Returns a signal instead when input is needed. */
async function run(
  target: { kind: "operation" | "resource" | "prompt"; app: string; name: string; output?: StandardSchemaV1 },
  options: InvokeOptions & { requestId: string },
  asker: Asker,
  call: (ctx: Context) => unknown,
): Promise<{ value: unknown } | { signal: InputRequiredSignal }> {
  const principal = options.principal ?? anonymous;
  const attributes: Attributes = {
    "syrinx.app": target.app,
    [`syrinx.${target.kind}`]: target.name,
    "syrinx.surface": options.surface ?? "in-process",
    "syrinx.principal": principal.id,
    "syrinx.tenant": options.tenant?.id,
    "syrinx.request_id": options.requestId,
  };
  const log = withAttributes(options.logger ?? noopLogger, attributes);
  const span = (options.tracer ?? noopTracer).startSpan(
    `${target.kind} ${target.app}.${target.name}`,
    attributes,
    options.traceContext,
  );
  let pending: InputRequiredSignal | undefined;
  const ask = async <T>(question: () => Promise<T>) => {
    try {
      return await question();
    } catch (error) {
      if (error instanceof InputRequiredSignal) pending ??= error;
      throw error;
    }
  };

  try {
    const result = await call({
      deps: options.deps,
      principal,
      tenant: options.tenant,
      requestId: options.requestId,
      idempotencyKey: options.idempotencyKey,
      canAsk: options.canAsk ?? true,
      signal: options.signal ?? new AbortController().signal,
      log,
      span,
      confirm: (message, opts) => ask(() => asker.confirm(message, opts)),
      ask: (message, schema, opts) => ask(() => asker.ask(message, schema, opts)),
      errors,
    });
    if (pending) {
      // The handler caught the signal and carried on; its answer is still missing, so ask anyway.
      log.warn("handler swallowed an input request; asking anyway");
      return { signal: pending };
    }
    if (!target.output) return { value: result };
    // Output is validated too: a handler that breaks its declared contract is a server bug, not a client error.
    const checked = await target.output["~standard"].validate(result);
    if (checked.issues) {
      throw new SyrinxError("internal", `${target.app}.${target.name} returned output that fails its schema.`);
    }
    return { value: checked.value };
  } catch (error) {
    if (error instanceof InputRequiredSignal) return { signal: error };
    span.recordException(error);
    throw error;
  } finally {
    span.end();
  }
}

/** Outcomes worth replaying for a repeated key. Transient failures release the key so a retry can run. */
const STORED_ERRORS = new Set<ErrorKind>(["validation", "unauthenticated", "forbidden", "not_found", "conflict"]);

export function createRegistry(apps: readonly App[], registryOptions: RegistryOptions = {}): Registry {
  const byName = new Map<string, App>();
  const uris = new Map<string, string>();
  for (const app of apps) {
    if (byName.has(app.name)) throw new TypeError(`Duplicate app name "${app.name}".`);
    byName.set(app.name, app);
    for (const [name, res] of Object.entries(app.resources)) {
      const owner = uris.get(res.uri);
      if (owner) throw new TypeError(`Resource "${app.name}.${name}" reuses URI template "${res.uri}" from ${owner}.`);
      uris.set(res.uri, `${app.name}.${name}`);
    }
  }
  // An embedded view ships in its parent's bundle but calls its own app's operations, so that app must be here too.
  for (const app of apps) {
    for (const v of Object.values(app.views)) {
      for (const child of v.embeds) {
        if (byName.get(child.app)?.views[child.name] !== child) {
          throw new TypeError(
            `View "${app.name}.${v.name}" embeds "${child.app}.${child.name}", whose app is not registered.`,
          );
        }
      }
      for (const target of v.navigatesTo()) {
        if (byName.get(target.app)?.views[target.name] !== target) {
          throw new TypeError(
            `View "${app.name}.${v.name}" navigates to "${target.app}.${target.name}", whose app is not registered.`,
          );
        }
      }
    }
  }

  const get = (app: string, operation: string) => own(byName.get(app)?.operations, operation);
  const getResource = (app: string, resource: string) => own(byName.get(app)?.resources, resource);
  const getPrompt = (app: string, name: string) => own(byName.get(app)?.prompts, name);
  const getView = (app: string, name: string) => own(byName.get(app)?.views, name);
  const member = (target: Target) =>
    target.operation !== undefined
      ? get(target.app, target.operation)
      : target.resource !== undefined
        ? getResource(target.app, target.resource)
        : target.prompt !== undefined
          ? getPrompt(target.app, target.prompt)
          : undefined;
  const scoped = (permissions: Permissions<never> | undefined) => Array.isArray(permissions) && permissions.length > 0;
  const personalized =
    registryOptions.isEnabled !== undefined ||
    [...byName.values()].some((app) =>
      [...Object.values(app.operations), ...Object.values(app.resources), ...Object.values(app.prompts)].some((m) =>
        scoped(m.permissions),
      ),
    );

  let codec: RequestStateCodec | undefined;
  const requestStates = (what: string) => {
    const key = registryOptions.requestStateKey;
    if (!key) throw new SyrinxError("internal", `${what} asked for input, but the registry has no requestStateKey.`);
    return (codec ??= createRequestStateCodec(key, registryOptions.requestStateTtlSeconds));
  };

  let viewTokens: ViewTokenCodec | undefined;
  const viewTokenCodec = () => {
    const key = registryOptions.requestStateKey;
    return key ? (viewTokens ??= createViewTokenCodec(key, registryOptions.viewTokenTtlSeconds)) : undefined;
  };
  const tokenBinding = (options: Pick<InvokeOptions, "principal" | "tenant">) => ({
    principal: (options.principal ?? anonymous).id,
    tenant: options.tenant?.id,
  });

  const ensureEnabled = async (target: Target, tenant?: Tenant) => {
    if (registryOptions.isEnabled && !(await registryOptions.isEnabled(target, tenant))) {
      const kind = target.operation ? "operation" : target.resource ? "resource" : "prompt";
      throw errors.notFound(`Unknown ${kind} "${target.app}.${target.operation ?? target.resource ?? target.prompt}".`);
    }
  };

  async function pipeline(
    appName: string,
    opName: string,
    operation: Operation,
    rawInput: unknown,
    options: InvokeOptions & { requestId: string },
    track: { interactionId?: string },
  ): Promise<InvokeResult> {
    const what = `${appName}.${opName}`;
    const principal = options.principal ?? anonymous;
    await ensureEnabled({ app: appName, operation: opName }, options.tenant);
    checkScopes(operation.permissions, principal, what);

    const parsed = await operation.input["~standard"].validate(rawInput);
    if (parsed.issues) throw errors.validation("Input failed validation.", toFieldIssues(parsed.issues));
    await checkPredicate(operation.permissions, principal, parsed.value, what);

    const inputHash = await sha256(canonicalJson(rawInput ?? null));
    const binding: Binding = {
      app: appName,
      operation: opName,
      principal: principal.id,
      tenant: options.tenant?.id,
      inputHash,
    };
    const opened = options.resume
      ? await requestStates(what).open(binding, options.resume)
      : { interactionId: crypto.randomUUID(), answers: [] };
    const { interactionId, answers } = opened;
    track.interactionId = interactionId;

    const store = !operation.annotations.readOnly && options.idempotencyKey ? registryOptions.idempotency : undefined;
    const storeKey = `${options.tenant?.id ?? ""}/${principal.id}/${what}/${options.idempotencyKey ?? ""}`;
    if (store) {
      const claim = await store.begin(storeKey, inputHash);
      if (claim.status === "in_flight") throw errors.conflict("A request with this Idempotency-Key is still running.");
      if (claim.status === "mismatch") {
        throw errors.unprocessable("This Idempotency-Key was already used for a different request.");
      }
      if (claim.status === "done") {
        const { outcome } = claim;
        if (outcome.ok) return { resultType: "complete", data: outcome.data, replayed: true };
        throw new SyrinxError(outcome.kind, outcome.message, outcome.issues);
      }
    }

    try {
      const outcome = await run(
        { kind: "operation", app: appName, name: opName, output: operation.output },
        options,
        operation.annotations.asks
          ? createAsker(answers, options.canAsk ?? true)
          : refuseAsking(`${what} asks for input but does not declare annotations.asks.`),
        (ctx) => perform(operation, parsed.value, ctx),
      );
      if ("signal" in outcome) {
        await store?.release(storeKey);
        const requestState = await requestStates(what).mint(binding, interactionId, answers, {
          key: outcome.signal.key,
          message: outcome.signal.request.message,
        });
        return {
          resultType: "input_required",
          inputRequests: { [outcome.signal.key]: outcome.signal.request },
          requestState,
        };
      }
      await store?.complete(storeKey, { ok: true, data: outcome.value });
      return { resultType: "complete", data: outcome.value };
    } catch (error) {
      if (store) {
        if (error instanceof SyrinxError && STORED_ERRORS.has(error.kind)) {
          await store.complete(storeKey, { ok: false, kind: error.kind, message: error.message, issues: error.issues });
        } else {
          await store.release(storeKey);
        }
      }
      throw error;
    }
  }

  return {
    apps: byName,
    get,
    getResource,
    getPrompt,
    getView,
    personalized,

    async allows(target, options = {}) {
      const found = member(target);
      if (!found) return false;
      if (registryOptions.isEnabled && !(await registryOptions.isEnabled(target, options.tenant))) return false;
      return holdsScopes(found.permissions, options.principal ?? anonymous);
    },

    async invoke(appName, opName, rawInput, invokeOptions = {}) {
      const operation = get(appName, opName);
      if (!operation || (invokeOptions.surface && !isVisible(operation, invokeOptions.surface))) {
        throw errors.notFound(`Unknown operation "${appName}.${opName}".`);
      }
      const options = { ...invokeOptions, requestId: invokeOptions.requestId ?? crypto.randomUUID() };
      const audit = operation.annotations.readOnly ? undefined : registryOptions.audit;
      const started = Date.now();
      const track: { interactionId?: string } = {};
      const report = async (outcome: AuditRecord["outcome"]) => {
        if (!audit) return;
        try {
          await audit({
            at: new Date(started).toISOString(),
            durationMs: Date.now() - started,
            requestId: options.requestId,
            surface: options.surface ?? "in-process",
            app: appName,
            operation: opName,
            principal: (options.principal ?? anonymous).id,
            tenant: options.tenant?.id,
            idempotencyKey: options.idempotencyKey,
            interactionId: (track.interactionId ??= crypto.randomUUID()),
            outcome,
          });
        } catch (error) {
          // A failed audit write must not undo or hide a write that already happened; log it loudly instead.
          (options.logger ?? noopLogger).error("audit hook failed", {
            error: String(error),
            app: appName,
            operation: opName,
          });
        }
      };

      try {
        const result = await pipeline(appName, opName, operation, rawInput, options, track);
        await report(
          result.resultType === "input_required" ? "input_required" : result.replayed ? "replayed" : "complete",
        );
        return result;
      } catch (error) {
        await report(error instanceof SyrinxError ? error.kind : "internal");
        throw error;
      }
    },

    async read(appName, resName, rawParams, invokeOptions = {}) {
      const res = getResource(appName, resName);
      if (!res) throw errors.notFound(`Unknown resource "${appName}.${resName}".`);
      const options = { ...invokeOptions, requestId: invokeOptions.requestId ?? crypto.randomUUID() };
      const principal = options.principal ?? anonymous;
      const what = `${appName}.${resName}`;
      await ensureEnabled({ app: appName, resource: resName }, options.tenant);
      checkScopes(res.permissions, principal, what);

      const params: Record<string, string> = {};
      const issues: FieldIssue[] = [];
      for (const name of templateVariables(res.uri)) {
        const value = rawParams[name];
        if (typeof value === "string" && value) params[name] = value;
        else issues.push({ path: name, message: "Required URI template parameter." });
      }
      if (issues.length) throw errors.validation("Resource parameters failed validation.", issues);
      await checkPredicate(res.permissions, principal, params, what);

      const outcome = await run(
        { kind: "resource", app: appName, name: resName, output: res.output },
        options,
        refuseAsking("Resources cannot ask for input."),
        (ctx) => res.read(params, ctx),
      );
      if ("signal" in outcome) throw new SyrinxError("internal", "Resources cannot ask for input.");
      return outcome.value;
    },

    checkRequestState: (requestState) => requestStates("A resumed call").check(requestState),

    async mintViewToken(view, options = {}) {
      return viewTokenCodec()?.mint(view, tokenBinding(options));
    },

    async openViewToken(token, options = {}) {
      const tokens = viewTokenCodec();
      if (!tokens)
        throw errors.validation("This server issues no view tokens.", [{ path: "token", message: "unknown" }]);
      return tokens.open(token, tokenBinding(options));
    },

    async render(appName, promptName, rawArgs, invokeOptions = {}) {
      const p = getPrompt(appName, promptName);
      if (!p) throw errors.notFound(`Unknown prompt "${appName}.${promptName}".`);
      const options = { ...invokeOptions, requestId: invokeOptions.requestId ?? crypto.randomUUID() };
      const principal = options.principal ?? anonymous;
      const what = `${appName}.${promptName}`;
      await ensureEnabled({ app: appName, prompt: promptName }, options.tenant);
      checkScopes(p.permissions, principal, what);

      let args: unknown = {};
      if (p.args) {
        const parsed = await p.args["~standard"].validate(rawArgs ?? {});
        if (parsed.issues) throw errors.validation("Prompt arguments failed validation.", toFieldIssues(parsed.issues));
        args = parsed.value;
      }
      await checkPredicate(p.permissions, principal, args, what);

      // Prompt state is bound under its own namespace, so it can never resume an operation of the same name.
      const binding: Binding = {
        app: appName,
        operation: `prompt:${promptName}`,
        principal: principal.id,
        tenant: options.tenant?.id,
        inputHash: await sha256(canonicalJson(rawArgs ?? {})),
      };
      const { interactionId, answers } = options.resume
        ? await requestStates(what).open(binding, options.resume)
        : { interactionId: crypto.randomUUID(), answers: [] };
      const outcome = await run(
        { kind: "prompt", app: appName, name: promptName },
        options,
        p.asks
          ? createAsker(answers, options.canAsk ?? true)
          : refuseAsking(`${what} asks for input but does not declare asks.`),
        (ctx) => p.render(args, ctx),
      );
      if ("signal" in outcome) {
        const requestState = await requestStates(what).mint(binding, interactionId, answers, {
          key: outcome.signal.key,
          message: outcome.signal.request.message,
        });
        return {
          resultType: "input_required",
          inputRequests: { [outcome.signal.key]: outcome.signal.request },
          requestState,
        };
      }
      const messages = toMessages(outcome.value as Parameters<typeof toMessages>[0]);
      return { resultType: "complete", data: { description: p.description, messages } };
    },

    async complete(request, invokeOptions = {}) {
      const { app: appName, argument } = request;
      const found =
        request.prompt !== undefined
          ? getPrompt(appName, request.prompt)
          : getResource(appName, request.resource ?? "");
      const name = request.prompt ?? request.resource ?? "";
      if (!found)
        throw errors.notFound(`Unknown ${request.prompt !== undefined ? "prompt" : "resource"} "${appName}.${name}".`);
      const options = { ...invokeOptions, requestId: invokeOptions.requestId ?? crypto.randomUUID() };
      const target: Target =
        request.prompt !== undefined ? { app: appName, prompt: name } : { app: appName, resource: name };
      await ensureEnabled(target, options.tenant);
      // Suggestions can leak data, so they need the same scopes as the member itself.
      checkScopes(found.permissions, options.principal ?? anonymous, `${appName}.${name}`);
      const completer = (found.complete as Record<string, Completer | undefined> | undefined)?.[argument];
      if (!completer) return { values: [], total: 0, hasMore: false };
      const outcome = await run(
        { kind: request.prompt !== undefined ? "prompt" : "resource", app: appName, name },
        options,
        refuseAsking("Completions cannot ask for input."),
        (ctx) => completer(request.value, { arguments: request.arguments ?? {} }, ctx),
      );
      if ("signal" in outcome) throw new SyrinxError("internal", "Completions cannot ask for input.");
      const all = [...(outcome.value as readonly string[])];
      return { values: all.slice(0, MAX_COMPLETIONS), total: all.length, hasMore: all.length > MAX_COMPLETIONS };
    },
  };
}
