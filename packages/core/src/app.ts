import { surfaces, type Context, type Principal, type Surface } from "./context.js";
import { toJsonSchema, type Schema, type SchemaSide } from "./schema.js";
import type { StandardSchemaV1 } from "./standard-schema.js";

export interface OperationAnnotations {
  /** No side effects. Allows GET over REST and maps to readOnlyHint over MCP. */
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  /**
   * The operation may answer `input_required` (it calls ctx.confirm / ctx.ask, or declares `confirm`). Documented in
   * OpenAPI and tool metadata; calling confirm or ask without it fails, so the documentation cannot drift.
   */
  asks?: boolean;
}

/**
 * Who may call an operation or read a resource: scopes the principal must all hold, or a predicate for rules that
 * depend on the input. Declared here, enforced by the policy pipeline.
 */
export type Permissions<Input> =
  | readonly string[]
  // Method syntax keeps the input parameter bivariant, like Operation.handler below.
  | { check(principal: Principal, input: Input): boolean | Promise<boolean> }["check"];

type Output<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S> | Promise<StandardSchemaV1.InferInput<S>>;

export interface Operation<
  In extends Schema = Schema,
  Out extends Schema = Schema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an untyped Deps must accept any typed operation
  Deps = any,
> {
  readonly kind: "operation";
  readonly description: string;
  readonly input: In;
  readonly output: Out;
  readonly annotations: OperationAnnotations;
  /** Where the operation can be called from. Empty only when a write left it undeclared, which defineApp rejects. */
  readonly visibility: readonly Surface[];
  readonly permissions?: Permissions<StandardSchemaV1.InferOutput<In>>;
  /**
   * Asks the caller to confirm before the handler runs: return the question, or undefined to skip it. It runs on
   * every round, so keep it free of side effects; the handler then runs exactly once. Declining fails the call as
   * `cancelled`.
   */
  confirm?(
    input: StandardSchemaV1.InferOutput<In>,
    ctx: Context<Deps>,
  ): string | undefined | Promise<string | undefined>;
  // Method syntax keeps the parameter bivariant, so a typed operation fits in Record<string, Operation>.
  handler(input: StandardSchemaV1.InferOutput<In>, ctx: Context<Deps>): Output<Out>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Operation's Deps default
export function op<In extends Schema, Out extends Schema, Deps = any>(
  def: Omit<Operation<In, Out, Deps>, "kind" | "annotations" | "visibility"> & {
    annotations?: OperationAnnotations;
    /** Defaults to every surface for read-only operations. Writes must opt in explicitly. */
    visibility?: readonly Surface[];
  },
): Operation<In, Out, Deps> {
  const annotations = def.confirm ? { ...def.annotations, asks: true } : (def.annotations ?? {});
  const visibility = def.visibility ?? (annotations.readOnly ? surfaces : []);
  return Object.freeze({ ...def, kind: "operation", annotations, visibility: Object.freeze([...visibility]) });
}

type TemplateVariables<T extends string> = T extends `${string}{${infer V}}${infer Rest}`
  ? V | TemplateVariables<Rest>
  : never;

/** The parameters of a URI template: `"invoice://{id}"` gives `{ id: string }`. */
export type UriParams<T extends string> = Record<TemplateVariables<T>, string>;

export interface Resource<
  Uri extends string = string,
  Out extends Schema = Schema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an untyped Deps must accept any typed resource
  Deps = any,
> {
  readonly kind: "resource";
  /** An RFC 6570 level 1 URI template, such as `invoice://{id}`. */
  readonly uri: Uri;
  readonly description?: string;
  readonly output: Out;
  readonly permissions?: Permissions<UriParams<Uri>>;
  read(params: UriParams<Uri>, ctx: Context<Deps>): Output<Out>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Resource's Deps default
export function resource<const Uri extends string, Out extends Schema, Deps = any>(
  def: Omit<Resource<Uri, Out, Deps>, "kind">,
): Resource<Uri, Out, Deps> {
  return Object.freeze({ ...def, kind: "resource" });
}

export interface AppDefinition<
  Ops extends Record<string, Operation>,
  Res extends Record<string, Resource> = Record<string, never>,
> {
  name: string;
  version: string;
  description: string;
  operations: Ops;
  resources?: Res;
}

export interface App<
  Ops extends Record<string, Operation> = Record<string, Operation>,
  Res extends Record<string, Resource> = Record<string, Resource>,
> {
  readonly kind: "app";
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly operations: Ops;
  readonly resources: Res;
}

const APP_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MEMBER_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
const URI_TEMPLATE = /^[a-z][a-z0-9+.-]*:[^{}]*(?:\{[A-Za-z_][A-Za-z0-9_]*\}[^{}]*)*$/;

/** The variable names in a URI template, in order. */
export function templateVariables(uri: string): string[] {
  return [...uri.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? "");
}

function checkPublishable(id: string, schema: StandardSchemaV1, side: SchemaSide) {
  try {
    toJsonSchema(schema, side);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(`${id} ${side} schema cannot be published as JSON Schema: ${reason}`, { cause: error });
  }
}

/** Matches a concrete URI against a level-1 template, returning its variables, or undefined when it does not fit. */
export function matchUriTemplate(template: string, uri: string): Record<string, string> | undefined {
  const names = templateVariables(template);
  const pattern = template
    .split(/\{[^}]+\}/)
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("([^/]+)");
  const match = new RegExp(`^${pattern}$`).exec(uri);
  if (!match) return undefined;
  try {
    return Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1] ?? "")]));
  } catch {
    return undefined; // malformed percent-encoding
  }
}

export function defineApp<
  Ops extends Record<string, Operation>,
  Res extends Record<string, Resource> = Record<string, never>,
>(def: AppDefinition<Ops, Res>): App<Ops, Res> {
  if (!APP_NAME.test(def.name)) {
    throw new TypeError(`App name "${def.name}" must be lowercase kebab-case, starting with a letter.`);
  }
  for (const [name, operation] of Object.entries(def.operations)) {
    const id = `Operation "${def.name}.${name}"`;
    if (!MEMBER_NAME.test(name)) throw new TypeError(`${id} must be camelCase, starting with a lowercase letter.`);
    if (!operation.description.trim()) throw new TypeError(`${id} needs a description; models choose tools by it.`);
    if (operation.visibility.length === 0) {
      throw new TypeError(`${id} must declare visibility; only read-only operations default to every surface.`);
    }
    const unknown = operation.visibility.find((s) => !surfaces.includes(s));
    if (unknown) throw new TypeError(`${id} has unknown visibility "${unknown}".`);
    checkPublishable(id, operation.input, "input");
    checkPublishable(id, operation.output, "output");
  }

  const resources = def.resources ?? ({} as Res);
  const uris = new Set<string>();
  for (const [name, res] of Object.entries(resources)) {
    const id = `Resource "${def.name}.${name}"`;
    if (!MEMBER_NAME.test(name)) throw new TypeError(`${id} must be camelCase, starting with a lowercase letter.`);
    if (!URI_TEMPLATE.test(res.uri)) {
      throw new TypeError(`${id} has URI template "${res.uri}"; expected scheme:path with {name} variables.`);
    }
    const vars = templateVariables(res.uri);
    if (new Set(vars).size !== vars.length) throw new TypeError(`${id} repeats a variable in "${res.uri}".`);
    if (uris.has(res.uri)) throw new TypeError(`${id} reuses URI template "${res.uri}".`);
    uris.add(res.uri);
    checkPublishable(id, res.output, "output");
  }

  return Object.freeze({
    kind: "app",
    name: def.name,
    version: def.version,
    description: def.description,
    operations: Object.freeze({ ...def.operations }),
    resources: Object.freeze({ ...resources }),
  });
}
