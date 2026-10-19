import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineApp, op, toJsonSchema, type JsonSchema, type StandardSchemaV1 } from "./index.js";

/** A schema whose converter returns a fixed document, for shapes Zod does not produce. */
const fixed = (document: JsonSchema): StandardSchemaV1 =>
  ({
    "~standard": {
      version: 1,
      vendor: "fixed",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => document, output: () => document },
    },
  }) as StandardSchemaV1;

describe("toJsonSchema", () => {
  it("inlines shared definitions and drops the $schema dialect", () => {
    const Address = z.object({ city: z.string() }).meta({ id: "Address" });
    expect(toJsonSchema(z.object({ billing: Address, shipping: Address }), "input")).toMatchSnapshot();
  });

  it("keeps root recursion as a local reference", () => {
    const Node: z.ZodType<{ name: string; children: unknown[] }> = z.object({
      name: z.string(),
      get children() {
        return z.array(Node);
      },
    });
    expect(toJsonSchema(Node, "input")).toMatchSnapshot();
  });

  it("keeps self-referencing definitions in $defs and inlines the rest", () => {
    const Category: z.ZodType<{ name: string; parent?: unknown }> = z
      .object({
        name: z.string(),
        get parent() {
          return Category.optional();
        },
      })
      .meta({ id: "Category" });
    const Tag = z.object({ label: z.string() }).meta({ id: "Tag" });
    const converted = toJsonSchema(z.object({ category: Category, tag: Tag }), "input");
    expect(Object.keys(converted.$defs as object)).toEqual(["Category"]);
    expect(converted).toMatchSnapshot();
  });

  it("describes inputs before defaults and outputs after them", () => {
    const schema = z.object({ limit: z.number().default(20) });
    expect(toJsonSchema(schema, "input")).not.toHaveProperty("required");
    expect(toJsonSchema(schema, "output")).toMatchObject({ required: ["limit"] });
  });

  it("combines keywords that sit beside a $ref instead of dropping them", () => {
    const schema = fixed({
      type: "object",
      properties: { id: { $ref: "#/$defs/Id", description: "The invoice id." } },
      $defs: { Id: { type: "string", minLength: 3 } },
    });
    expect(toJsonSchema(schema, "input")).toEqual({
      type: "object",
      properties: { id: { allOf: [{ type: "string", minLength: 3 }], description: "The invoice id." } },
    });
  });

  it("decodes JSON Pointer escapes in definition names", () => {
    const schema = fixed({ $ref: "#/$defs/a~1b", $defs: { "a/b": { type: "string" } } });
    expect(toJsonSchema(schema, "input")).toEqual({ type: "string" });
  });

  it("rejects references to missing definitions", () => {
    expect(() => toJsonSchema(fixed({ $ref: "#/$defs/Nope" }), "input")).toThrow(/missing definition "Nope"/);
  });

  it("rejects schemas without a Standard JSON Schema converter", () => {
    const plain = { "~standard": { version: 1, vendor: "acme", validate: (value: unknown) => ({ value }) } } as const;
    expect(() => toJsonSchema(plain, "input")).toThrow(/acme schema does not implement Standard JSON Schema/);
  });

  it("caches conversions per schema and side", () => {
    const schema = z.object({ id: z.string() });
    expect(toJsonSchema(schema, "input")).toBe(toJsonSchema(schema, "input"));
  });
});

describe("defineApp schema checks", () => {
  it("rejects operations whose schemas cannot be published", () => {
    const stamp = op({
      description: "Return the current time.",
      input: z.object({}),
      output: z.object({ at: z.date() }),
      annotations: { readOnly: true },
      handler: () => ({ at: new Date() }),
    });
    expect(() => defineApp({ name: "clock", version: "1", description: "x", operations: { stamp } })).toThrow(
      /Operation "clock.stamp" output schema cannot be published as JSON Schema: Date cannot be represented/,
    );
  });

  it("allows transforms on input, where the published side is the pre-transform shape", () => {
    const parse = op({
      description: "Parse a number.",
      input: z.object({ n: z.string().transform(Number) }),
      output: z.object({ n: z.number() }),
      annotations: { readOnly: true },
      handler: ({ n }) => ({ n }),
    });
    expect(() => defineApp({ name: "parse", version: "1", description: "x", operations: { parse } })).not.toThrow();
    expect(toJsonSchema(parse.input, "input")).toMatchObject({ properties: { n: { type: "string" } } });
  });
});
