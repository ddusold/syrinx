import type { App, Operation } from "./app.js";
import { errors, SyrinxError, toFieldIssues } from "./errors.js";

export interface InvokeOptions<Deps = unknown> {
  deps?: Deps;
  requestId?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface Registry {
  readonly apps: ReadonlyMap<string, App>;
  get(app: string, operation: string): Operation | undefined;
  invoke(app: string, operation: string, input: unknown, options?: InvokeOptions): Promise<unknown>;
}

export function createRegistry(apps: readonly App[]): Registry {
  const byName = new Map<string, App>();
  for (const app of apps) {
    if (byName.has(app.name)) throw new TypeError(`Duplicate app name "${app.name}".`);
    byName.set(app.name, app);
  }

  const get = (app: string, operation: string) => {
    const ops = byName.get(app)?.operations;
    return ops && Object.hasOwn(ops, operation) ? ops[operation] : undefined;
  };

  return {
    apps: byName,
    get,
    async invoke(appName, opName, rawInput, options = {}) {
      const operation = get(appName, opName);
      if (!operation) throw errors.notFound(`Unknown operation "${appName}.${opName}".`);

      const parsed = await operation.input["~standard"].validate(rawInput);
      if (parsed.issues) throw errors.validation("Input failed validation.", toFieldIssues(parsed.issues));

      const signal = options.signal ?? new AbortController().signal;
      const result = await operation.handler(parsed.value, {
        deps: options.deps,
        requestId: options.requestId ?? crypto.randomUUID(),
        idempotencyKey: options.idempotencyKey,
        signal,
        errors,
      });

      // Output is validated too: a handler that breaks its declared contract is a server bug, not a client error.
      const checked = await operation.output["~standard"].validate(result);
      if (checked.issues) {
        throw new SyrinxError("internal", `Operation "${appName}.${opName}" returned output that fails its schema.`);
      }
      return checked.value;
    },
  };
}
