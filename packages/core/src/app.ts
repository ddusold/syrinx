import type { ContentBlock, PromptContent } from "./content.js";
import { surfaces, type Context, type Principal, type Surface } from "./context.js";
import { toJsonSchema, type Schema, type SchemaSide } from "./schema.js";
import type { StandardSchemaV1 } from "./standard-schema.js";

export interface OperationAnnotations {
  /** No side effects. Allows GET over REST and maps to readOnlyHint over MCP. */
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  /** Reaches systems outside the app's own data (the web, third-party APIs). Maps to openWorldHint over MCP. */
  openWorld?: boolean;
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

/**
 * Suggests values for a prompt argument or resource template variable as the user types. `context.arguments` holds
 * the other arguments filled in so far. At most 100 suggestions are sent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an untyped Deps must accept any typed completer
export type Completer<Deps = any> = (
  value: string,
  context: { arguments: Record<string, string> },
  ctx: Context<Deps>,
) => readonly string[] | Promise<readonly string[]>;

type Output<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S> | Promise<StandardSchemaV1.InferInput<S>>;

/** Per-operation escape hatch for the MCP projection. Everything else about the tool is generated. */
export interface McpOverrides<Out = unknown> {
  /** Tool name in place of the operation name (the all-apps endpoint still prefixes `{app}_`). */
  name?: string;
  /** Model-facing description, when it should differ from the description humans read in OpenAPI. */
  description?: string;
  /** Content blocks in place of the default JSON text rendering of the output. */
  content?(output: Out): readonly ContentBlock[];
  /** False to send only `content`: no outputSchema, no structuredContent. For tools whose result is the content. */
  structured?: false;
  /** Extra tool `_meta`, merged over what Syrinx generates. */
  meta?: Record<string, unknown>;
}

export interface Operation<
  In extends Schema = Schema,
  Out extends Schema = Schema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an untyped Deps must accept any typed operation
  Deps = any,
> {
  readonly kind: "operation";
  /** Short display name for humans; MCP clients show it in tool pickers. */
  readonly title?: string;
  readonly description: string;
  readonly input: In;
  readonly output: Out;
  readonly annotations: OperationAnnotations;
  /** Where the operation can be called from. Empty only when a write left it undeclared, which defineApp rejects. */
  readonly visibility: readonly Surface[];
  readonly permissions?: Permissions<StandardSchemaV1.InferOutput<In>>;
  readonly mcp?: McpOverrides<StandardSchemaV1.InferOutput<Out>>;
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
  /**
   * Defaults to application/json. Any other type makes the output the raw body: text for text/* types, base64 for
   * the rest.
   */
  readonly mimeType?: string;
  readonly output: Out;
  readonly permissions?: Permissions<UriParams<Uri>>;
  /** Suggestions for template variables, keyed by variable name. */
  readonly complete?: Partial<Record<TemplateVariables<Uri>, Completer<Deps>>>;
  read(params: UriParams<Uri>, ctx: Context<Deps>): Output<Out>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Resource's Deps default
export function resource<const Uri extends string, Out extends Schema, Deps = any>(
  def: Omit<Resource<Uri, Out, Deps>, "kind">,
): Resource<Uri, Out, Deps> {
  return Object.freeze({ ...def, kind: "resource" });
}

/**
 * A reusable message template a user picks in their client, such as "review this invoice". Arguments are strings,
 * because MCP clients collect them as form fields.
 */
export interface Prompt<
  Args extends Schema = Schema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an untyped Deps must accept any typed prompt
  Deps = any,
> {
  readonly kind: "prompt";
  readonly title?: string;
  readonly description: string;
  /** An object schema whose properties are all strings. Omit for a prompt without arguments. */
  readonly args?: Args;
  readonly permissions?: Permissions<StandardSchemaV1.InferOutput<Args>>;
  /** Prompt name over MCP in place of the member name (the all-apps endpoint still prefixes `{app}_`). */
  readonly mcp?: { name?: string };
  /** The prompt may ask the user for input while rendering (ctx.confirm / ctx.ask), as operations with `asks` do. */
  readonly asks?: boolean;
  /** Suggestions for arguments, keyed by argument name. */
  readonly complete?: Partial<Record<keyof StandardSchemaV1.InferOutput<Args> & string, Completer<Deps>>>;
  render(args: StandardSchemaV1.InferOutput<Args>, ctx: Context<Deps>): PromptContent | Promise<PromptContent>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Prompt's Deps default
export function prompt<Args extends Schema, Deps = any>(def: Omit<Prompt<Args, Deps>, "kind">): Prompt<Args, Deps> {
  return Object.freeze({ ...def, kind: "prompt" });
}

export interface AppDefinition<
  Ops extends Record<string, Operation>,
  Res extends Record<string, Resource> = Record<string, never>,
  Prompts extends Record<string, Prompt> = Record<string, never>,
> {
  name: string;
  version: string;
  description: string;
  operations: Ops;
  resources?: Res;
  prompts?: Prompts;
}

export interface App<
  Ops extends Record<string, Operation> = Record<string, Operation>,
  Res extends Record<string, Resource> = Record<string, Resource>,
  Prompts extends Record<string, Prompt> = Record<string, Prompt>,
> {
  readonly kind: "app";
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly operations: Ops;
  readonly resources: Res;
  readonly prompts: Prompts;
}

const APP_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MEMBER_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
/** MCP tool names allow more than member names do; overrides may use them (SEP-986). */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
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

/** Prompt arguments arrive as form fields, so every property must be a string. */
function checkPromptArgs(id: string, schema: StandardSchemaV1) {
  const json = toJsonSchema(schema, "input");
  const properties = (json.properties ?? {}) as Record<string, { type?: unknown; enum?: unknown[] }>;
  const stringly = (p: { type?: unknown; enum?: unknown[] }) =>
    p.type === "string" || (Array.isArray(p.enum) && p.enum.every((v) => typeof v === "string"));
  if (json.type !== "object" || !Object.values(properties).every(stringly)) {
    throw new TypeError(`${id} args must be an object schema whose properties are all strings.`);
  }
}

export function defineApp<
  Ops extends Record<string, Operation>,
  Res extends Record<string, Resource> = Record<string, never>,
  Prompts extends Record<string, Prompt> = Record<string, never>,
>(def: AppDefinition<Ops, Res, Prompts>): App<Ops, Res, Prompts> {
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
    if (operation.mcp?.name !== undefined && !TOOL_NAME.test(operation.mcp.name)) {
      throw new TypeError(`${id} has MCP name "${operation.mcp.name}"; use 1-64 letters, digits, "_", "-" or ".".`);
    }
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

  const prompts = def.prompts ?? ({} as Prompts);
  for (const [name, p] of Object.entries(prompts)) {
    const id = `Prompt "${def.name}.${name}"`;
    if (!MEMBER_NAME.test(name)) throw new TypeError(`${id} must be camelCase, starting with a lowercase letter.`);
    if (!p.description.trim()) throw new TypeError(`${id} needs a description.`);
    if (p.mcp?.name !== undefined && !TOOL_NAME.test(p.mcp.name)) {
      throw new TypeError(`${id} has MCP name "${p.mcp.name}"; use 1-64 letters, digits, "_", "-" or ".".`);
    }
    if (p.args) {
      checkPublishable(id, p.args, "input");
      checkPromptArgs(id, p.args);
    }
  }

  return Object.freeze({
    kind: "app",
    name: def.name,
    version: def.version,
    description: def.description,
    operations: Object.freeze({ ...def.operations }),
    resources: Object.freeze({ ...resources }),
    prompts: Object.freeze({ ...prompts }),
  });
}
