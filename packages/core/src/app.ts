import { errors } from "./errors.js";
import type { StandardSchemaV1 } from "./standard-schema.js";

export interface OperationAnnotations {
  /** No side effects. Allows GET over REST and maps to readOnlyHint over MCP. */
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
}

export interface Context<Deps = unknown> {
  /** User-provided services, injected per host. */
  deps: Deps;
  requestId: string;
  idempotencyKey: string | undefined;
  signal: AbortSignal;
  errors: typeof errors;
}

export interface Operation<
  In extends StandardSchemaV1 = StandardSchemaV1,
  Out extends StandardSchemaV1 = StandardSchemaV1,
  Deps = any,
> {
  readonly kind: "operation";
  readonly description: string;
  readonly input: In;
  readonly output: Out;
  readonly annotations: OperationAnnotations;
  // Method syntax keeps the parameter bivariant, so a typed operation fits in Record<string, Operation>.
  handler(
    input: StandardSchemaV1.InferOutput<In>,
    ctx: Context<Deps>,
  ): StandardSchemaV1.InferInput<Out> | Promise<StandardSchemaV1.InferInput<Out>>;
}

export function op<In extends StandardSchemaV1, Out extends StandardSchemaV1, Deps = any>(
  def: Omit<Operation<In, Out, Deps>, "kind" | "annotations"> & { annotations?: OperationAnnotations },
): Operation<In, Out, Deps> {
  return Object.freeze({ ...def, kind: "operation", annotations: def.annotations ?? {} });
}

export interface AppDefinition<Ops extends Record<string, Operation>> {
  name: string;
  version: string;
  description: string;
  operations: Ops;
}

export interface App<Ops extends Record<string, Operation> = Record<string, Operation>> extends AppDefinition<Ops> {
  readonly kind: "app";
}

const APP_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const OP_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;

export function defineApp<Ops extends Record<string, Operation>>(def: AppDefinition<Ops>): App<Ops> {
  if (!APP_NAME.test(def.name)) {
    throw new TypeError(`App name "${def.name}" must be lowercase kebab-case, starting with a letter.`);
  }
  for (const [name, operation] of Object.entries(def.operations)) {
    if (!OP_NAME.test(name)) {
      throw new TypeError(`Operation "${def.name}.${name}" must be camelCase, starting with a lowercase letter.`);
    }
    if (!operation.description.trim()) {
      throw new TypeError(`Operation "${def.name}.${name}" needs a description; models choose tools by it.`);
    }
  }
  return Object.freeze({ ...def, operations: Object.freeze({ ...def.operations }), kind: "app" });
}
