import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRegistry, defineApp, op, SyrinxError } from "./index.js";

const Invoice = z.object({ id: z.string(), totalCents: z.number().int() });

const invoices = defineApp({
  name: "invoices",
  version: "1.0.0",
  description: "Look up customer invoices.",
  operations: {
    get: op({
      description: "Fetch one invoice by id.",
      input: z.object({ id: z.string() }),
      output: Invoice,
      annotations: { readOnly: true },
      handler: ({ id }, ctx) => {
        if (id === "missing") throw ctx.errors.notFound(`No invoice ${id}.`);
        return { id, totalCents: id === "broken" ? 1.5 : 1200 };
      },
    }),
  },
});

const registry = createRegistry([invoices]);

describe("defineApp", () => {
  it("rejects names that cannot be used as routes or tool names", () => {
    expect(() => defineApp({ name: "Invoices", version: "1", description: "x", operations: {} })).toThrow(/kebab-case/);
  });

  it("requires a description on every operation", () => {
    const blank = op({ description: " ", input: z.object({}), output: z.object({}), handler: () => ({}) });
    expect(() => defineApp({ name: "a", version: "1", description: "x", operations: { blank } })).toThrow(
      /description/,
    );
  });
});

describe("createRegistry", () => {
  it("rejects duplicate app names", () => {
    expect(() => createRegistry([invoices, invoices])).toThrow(/Duplicate/);
  });

  it("invokes an operation with validated input", async () => {
    await expect(registry.invoke("invoices", "get", { id: "inv_1" })).resolves.toEqual({
      id: "inv_1",
      totalCents: 1200,
    });
  });

  it("reports input issues as a validation error with field paths", async () => {
    const error = await registry.invoke("invoices", "get", { id: 7 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyrinxError);
    expect(error).toMatchObject({ kind: "validation", status: 400, issues: [{ path: "id" }] });
  });

  it("passes domain errors through", async () => {
    await expect(registry.invoke("invoices", "get", { id: "missing" })).rejects.toMatchObject({ kind: "not_found" });
  });

  it("treats output that breaks the schema as an internal error", async () => {
    await expect(registry.invoke("invoices", "get", { id: "broken" })).rejects.toMatchObject({ kind: "internal" });
  });

  it("does not resolve inherited properties as operations", async () => {
    await expect(registry.invoke("invoices", "toString", {})).rejects.toMatchObject({ kind: "not_found" });
  });
});
