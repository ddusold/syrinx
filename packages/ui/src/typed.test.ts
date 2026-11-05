import { defineApp, op, view, type App } from "@syrinx/core";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { TypedViewProps } from "./typed.js";

const entry = new URL("file:///views/Browser.vue");
const contacts = defineApp({
  name: "contacts",
  version: "1.0.0",
  description: "Contacts.",
  operations: {
    list: op({
      description: "List.",
      input: z.object({ search: z.string().optional(), limit: z.number().default(20) }),
      output: z.object({ items: z.array(z.object({ id: z.string() })) }),
      annotations: { readOnly: true },
      handler: () => ({ items: [] }),
    }),
    get: op({
      description: "One.",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), name: z.string() }),
      annotations: { readOnly: true },
      handler: ({ id }) => ({ id, name: "n" }),
    }),
    purge: op({
      description: "Remove.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      visibility: ["rest"],
      handler: () => ({ ok: true }),
    }),
  },
  views: { browser: view({ entry, boundTo: ["list", { op: "get", component: "detail" }], calls: ["list", "get"] }) },
});

type Props = TypedViewProps<typeof contacts, "browser">;

// Type-level only: these checks run in the typecheck, not at runtime.
describe("typed view props", () => {
  it("types data as the bound operations' outputs", () => {
    expectTypeOf<Props["data"]>().toEqualTypeOf<
      { items: { id: string }[] } | { id: string; name: string } | undefined
    >();
  });

  it("checks call names and inputs against the view's calls", () => {
    const emit = { call: () => Promise.resolve({}) } as unknown as Props["emit"];
    expectTypeOf(emit.call("get", { id: "c1" })).resolves.toEqualTypeOf<{ id: string; name: string }>();
    expectTypeOf(emit.call("list")).resolves.toEqualTypeOf<{ items: { id: string }[] }>();
    expectTypeOf(emit.call("list", { search: "ry" })).resolves.toEqualTypeOf<{ items: { id: string }[] }>();
    // @ts-expect-error get needs an id
    void emit.call("get");
    // @ts-expect-error the id must be a string
    void emit.call("get", { id: 1 });
    // @ts-expect-error purge exists, but this view does not list it in calls
    void emit.call("purge", {});
    // @ts-expect-error no such operation
    void emit.call("lst");
    expectTypeOf(emit.call("exports.new", {})).resolves.toEqualTypeOf<unknown>();
  });

  it("is assignable from any app", () => {
    expectTypeOf(contacts).toExtend<App>();
  });
});
