import type { JsonSchema } from "@syrinx/core";

const types = (schema: JsonSchema | undefined): string[] => {
  const type = schema?.type;
  return Array.isArray(type) ? (type as string[]) : typeof type === "string" ? [type] : [];
};

function coerce(value: string, schema: JsonSchema | undefined): unknown {
  const allowed = types(schema);
  if (allowed.length === 0 || allowed.includes("string")) return value;
  if ((allowed.includes("number") || allowed.includes("integer")) && value.trim() !== "" && !isNaN(Number(value))) {
    return Number(value);
  }
  if (allowed.includes("boolean") && (value === "true" || value === "false")) return value === "true";
  if (allowed.includes("null") && value === "null") return null;
  if (allowed.includes("object") || allowed.includes("array")) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value; // leave it to validation to report
}

/**
 * Turns query parameters into typed input using the operation's input JSON Schema: `?limit=5` becomes a number when
 * the schema says so, and repeated parameters become arrays. Anything that does not fit stays a string, so schema
 * validation reports it with the right field path.
 */
export function inputFromQuery(url: URL, schema: JsonSchema): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const input: Record<string, unknown> = {};
  for (const name of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(name);
    const property = properties[name];
    if (types(property).includes("array") && !(values.length === 1 && values[0]?.startsWith("["))) {
      input[name] = values.map((v) => coerce(v, property?.items as JsonSchema | undefined));
    } else {
      input[name] = coerce(values.at(-1) ?? "", property);
    }
  }
  return input;
}
