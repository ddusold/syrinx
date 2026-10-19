import type { StandardJSONSchemaV1, StandardSchemaV1 } from "./standard-schema.js";

/** A schema Syrinx can both validate with and publish: Standard Schema plus Standard JSON Schema. */
export type Schema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> &
  StandardJSONSchemaV1<Input, Output>;

/** A JSON Schema 2020-12 document. */
export type JsonSchema = Record<string, unknown>;

/**
 * Which side of the schema to describe. `input` is what callers send (before defaults and transforms); `output` is
 * what Syrinx returns after validating a handler's result.
 */
export type SchemaSide = "input" | "output";

const cache = new WeakMap<object, Partial<Record<SchemaSide, JsonSchema>>>();

/**
 * Converts a schema to JSON Schema 2020-12 with local `$ref`s inlined, so consumers never resolve references.
 * Definitions that refer to themselves cannot be inlined and stay in `$defs`. Results are cached per schema.
 * Throws when the schema has no Standard JSON Schema converter or its library cannot represent it.
 */
export function toJsonSchema(schema: StandardSchemaV1, side: SchemaSide): JsonSchema {
  const cached = cache.get(schema)?.[side];
  if (cached) return cached;

  // Typed callers can only pass a Schema, but JavaScript callers and adapters may hand over a plain Standard Schema.
  const converter = (schema["~standard"] as Partial<StandardJSONSchemaV1.Props>).jsonSchema;
  if (!converter) {
    const vendor = schema["~standard"].vendor;
    throw new TypeError(
      `The ${vendor} schema does not implement Standard JSON Schema (~standard.jsonSchema), so it cannot be published.`,
    );
  }
  const converted = inlineRefs(converter[side]({ target: "draft-2020-12" }));
  cache.set(schema, { ...cache.get(schema), [side]: converted });
  return converted;
}

const DEFS_PREFIX = "#/$defs/";
const unescapePointer = (segment: string) => decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function inlineRefs(document: JsonSchema): JsonSchema {
  const { $schema: _dialect, $defs, ...root } = document;
  const defs = isObject($defs) ? $defs : {};
  const kept = new Set<string>();

  const resolve = (node: unknown, stack: readonly string[]): unknown => {
    if (Array.isArray(node)) return node.map((item) => resolve(item, stack));
    if (!isObject(node)) return node;

    const ref = node.$ref;
    if (typeof ref === "string" && ref.startsWith(DEFS_PREFIX)) {
      const name = unescapePointer(ref.slice(DEFS_PREFIX.length));
      if (stack.includes(name)) {
        kept.add(name);
        return node;
      }
      if (!(name in defs)) throw new TypeError(`JSON Schema refers to missing definition "${name}".`);
      const target = resolve(defs[name], [...stack, name]);
      const { $ref: _ref, ...siblings } = node;
      // 2020-12 allows keywords beside $ref; keep them by combining rather than overwriting the target's.
      return Object.keys(siblings).length ? { allOf: [target], ...(resolve(siblings, stack) as JsonSchema) } : target;
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolve(value, stack)]));
  };

  const result = resolve(root, []) as JsonSchema;

  // Self-referencing definitions stay as $defs. Resolving one may keep more; Set iteration visits those too.
  const keptDefs: JsonSchema = {};
  for (const name of kept) keptDefs[name] = resolve(defs[name], [name]);
  return kept.size ? { ...result, $defs: keptDefs } : result;
}
