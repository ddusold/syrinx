import { templateVariables, type App, type Operation, type Resource } from "./app.js";
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
  type Tracer,
} from "./context.js";
import { errors, SyrinxError, toFieldIssues, type FieldIssue } from "./errors.js";
import type { StandardSchemaV1 } from "./standard-schema.js";

export interface InvokeOptions<Deps = unknown> {
  deps?: Deps;
  principal?: Principal;
  tenant?: Tenant;
  /** The surface the call came in on. Operations not visible there are reported as not found. Omit for in-process calls. */
  surface?: Surface;
  requestId?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  logger?: Logger;
  tracer?: Tracer;
}

export interface Registry {
  readonly apps: ReadonlyMap<string, App>;
  get(app: string, operation: string): Operation | undefined;
  getResource(app: string, resource: string): Resource | undefined;
  invoke(app: string, operation: string, input: unknown, options?: InvokeOptions): Promise<unknown>;
  read(app: string, resource: string, params: Record<string, unknown>, options?: InvokeOptions): Promise<unknown>;
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

/** Builds the context, wraps the call in a span, and validates output against its schema. */
async function run(
  target: { kind: "operation" | "resource"; app: string; name: string; output: StandardSchemaV1 },
  options: InvokeOptions,
  call: (ctx: Context) => unknown,
): Promise<unknown> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const principal = options.principal ?? anonymous;
  const attributes: Attributes = {
    "syrinx.app": target.app,
    [`syrinx.${target.kind}`]: target.name,
    "syrinx.surface": options.surface ?? "in-process",
    "syrinx.principal": principal.id,
    "syrinx.tenant": options.tenant?.id,
    "syrinx.request_id": requestId,
  };
  const span = (options.tracer ?? noopTracer).startSpan(`${target.kind} ${target.app}.${target.name}`, attributes);
  try {
    const result = await call({
      deps: options.deps,
      principal,
      tenant: options.tenant,
      requestId,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal ?? new AbortController().signal,
      log: withAttributes(options.logger ?? noopLogger, attributes),
      span,
      errors,
    });
    // Output is validated too: a handler that breaks its declared contract is a server bug, not a client error.
    const checked = await target.output["~standard"].validate(result);
    if (checked.issues) {
      throw new SyrinxError("internal", `${target.app}.${target.name} returned output that fails its schema.`);
    }
    return checked.value;
  } catch (error) {
    span.recordException(error);
    throw error;
  } finally {
    span.end();
  }
}

export function createRegistry(apps: readonly App[]): Registry {
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

  const get = (app: string, operation: string) => own(byName.get(app)?.operations, operation);
  const getResource = (app: string, resource: string) => own(byName.get(app)?.resources, resource);

  return {
    apps: byName,
    get,
    getResource,

    async invoke(appName, opName, rawInput, options = {}) {
      const operation = get(appName, opName);
      if (!operation || (options.surface && !isVisible(operation, options.surface))) {
        throw errors.notFound(`Unknown operation "${appName}.${opName}".`);
      }

      const parsed = await operation.input["~standard"].validate(rawInput);
      if (parsed.issues) throw errors.validation("Input failed validation.", toFieldIssues(parsed.issues));

      return run({ kind: "operation", app: appName, name: opName, output: operation.output }, options, (ctx) =>
        operation.handler(parsed.value, ctx),
      );
    },

    async read(appName, resName, rawParams, options = {}) {
      const res = getResource(appName, resName);
      if (!res) throw errors.notFound(`Unknown resource "${appName}.${resName}".`);

      const params: Record<string, string> = {};
      const issues: FieldIssue[] = [];
      for (const name of templateVariables(res.uri)) {
        const value = rawParams[name];
        if (typeof value === "string" && value) params[name] = value;
        else issues.push({ path: name, message: "Required URI template parameter." });
      }
      if (issues.length) throw errors.validation("Resource parameters failed validation.", issues);

      return run({ kind: "resource", app: appName, name: resName, output: res.output }, options, (ctx) =>
        res.read(params, ctx),
      );
    },
  };
}
