import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  createRegistry,
  defineApp,
  noopLogger,
  noopTracer,
  op,
  resource,
  SyrinxError,
  type Attributes,
  type Context,
  type Logger,
  type Tracer,
} from "./index.js";

const Invoice = z.object({ id: z.string(), totalCents: z.number().int() });

const invoices = defineApp({
  name: "invoices",
  version: "1.0.0",
  description: "Look up and send customer invoices.",
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
    send: op({
      description: "Email a draft invoice to its customer.",
      input: z.object({ id: z.string() }),
      output: z.object({ sentBy: z.string() }),
      visibility: ["app", "rest"],
      permissions: (_principal, { id }) => id !== "locked",
      handler: (_input, ctx) => ({ sentBy: ctx.principal.id }),
    }),
  },
  resources: {
    invoice: resource({
      uri: "invoice://{id}",
      description: "One invoice as JSON.",
      output: Invoice,
      read: ({ id }) => ({ id, totalCents: id === "broken" ? 1.5 : 900 }),
    }),
  },
});

const registry = createRegistry([invoices]);

const app = (overrides: Partial<Parameters<typeof defineApp>[0]>) =>
  defineApp({ name: "a", version: "1", description: "x", operations: {}, ...overrides });

describe("defineApp", () => {
  it("rejects names that cannot be used as routes or tool names", () => {
    expect(() => app({ name: "Invoices" })).toThrow(/kebab-case/);
  });

  it("requires a description on every operation", () => {
    const blank = op({ description: " ", input: z.object({}), output: z.object({}), handler: () => ({}) });
    expect(() => app({ operations: { blank } })).toThrow(/description/);
  });

  it("makes read-only operations visible everywhere by default", () => {
    expect(invoices.operations.get.visibility).toEqual(["model", "app", "rest"]);
  });

  it("requires write operations to declare visibility", () => {
    const write = op({ description: "Write.", input: z.object({}), output: z.object({}), handler: () => ({}) });
    expect(() => app({ operations: { write } })).toThrow(/must declare visibility/);
  });

  it("rejects unknown surfaces", () => {
    const write = op({
      description: "Write.",
      input: z.object({}),
      output: z.object({}),
      visibility: ["graphql" as "rest"],
      handler: () => ({}),
    });
    expect(() => app({ operations: { write } })).toThrow(/unknown visibility "graphql"/);
  });

  it("rejects malformed and duplicate resource URI templates", () => {
    const read = () => ({});
    const res = (uri: string) => resource({ uri, output: z.object({}), read });
    expect(() => app({ resources: { bad: res("no-scheme/{id}") } })).toThrow(/URI template/);
    expect(() => app({ resources: { bad: res("x://{id}/{id}") } })).toThrow(/repeats a variable/);
    expect(() => app({ resources: { one: res("x://{id}"), two: res("x://{id}") } })).toThrow(/reuses/);
  });

  it("infers resource parameters from the URI template", () => {
    expectTypeOf<Parameters<typeof invoices.resources.invoice.read>[0]>().toEqualTypeOf<{ id: string }>();
  });
});

describe("createRegistry", () => {
  it("rejects duplicate app names", () => {
    expect(() => createRegistry([invoices, invoices])).toThrow(/Duplicate/);
  });

  it("rejects resource URI templates shared across apps", () => {
    const copy = defineApp({ ...invoices, name: "copy", resources: invoices.resources });
    expect(() => createRegistry([invoices, copy])).toThrow(/reuses URI template "invoice:\/\/\{id\}"/);
  });

  it("invokes an operation with validated input", async () => {
    await expect(registry.invoke("invoices", "get", { id: "inv_1" })).resolves.toEqual({
      resultType: "complete",
      data: { id: "inv_1", totalCents: 1200 },
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

  it("hides operations from surfaces they are not visible on", async () => {
    await expect(registry.invoke("invoices", "send", { id: "1" }, { surface: "model" })).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(registry.invoke("invoices", "send", { id: "1" }, { surface: "rest" })).resolves.toBeDefined();
    await expect(registry.invoke("invoices", "send", { id: "1" })).resolves.toBeDefined();
  });
});

describe("context", () => {
  it("defaults to the anonymous principal and passes a given one through", async () => {
    await expect(registry.invoke("invoices", "send", { id: "1" })).resolves.toMatchObject({
      data: { sentBy: "anonymous" },
    });
    const principal = { id: "user_1", scopes: [] };
    await expect(registry.invoke("invoices", "send", { id: "1" }, { principal })).resolves.toMatchObject({
      data: { sentBy: "user_1" },
    });
  });

  it("gives handlers a logger with request attributes attached", async () => {
    const lines: [string, Attributes | undefined][] = [];
    const logger: Logger = { ...noopLogger, info: (m, a) => lines.push([m, a]) };
    let seen: Context | undefined;
    const logged = defineApp({
      name: "logged",
      version: "1",
      description: "x",
      operations: {
        ping: op({
          description: "Log once.",
          input: z.object({}),
          output: z.object({}),
          annotations: { readOnly: true },
          handler: (_input, ctx) => {
            seen = ctx;
            ctx.log.info("pinged", { extra: 1 });
            return {};
          },
        }),
      },
    });
    await createRegistry([logged]).invoke("logged", "ping", {}, { logger, requestId: "req_1", surface: "rest" });
    expect(seen?.tenant).toBeUndefined();
    expect(lines).toEqual([
      [
        "pinged",
        expect.objectContaining({
          "syrinx.app": "logged",
          "syrinx.operation": "ping",
          "syrinx.surface": "rest",
          "syrinx.request_id": "req_1",
          extra: 1,
        }),
      ],
    ]);
  });

  it("wraps each invocation in a span and records failures", async () => {
    const spans: { name: string; exceptions: unknown[]; ended: boolean }[] = [];
    const tracer: Tracer = {
      startSpan: (name) => {
        const span = { name, exceptions: [] as unknown[], ended: false };
        spans.push(span);
        return {
          ...noopTracer.startSpan(name, {}),
          recordException: (e) => span.exceptions.push(e),
          end: () => {
            span.ended = true;
          },
        };
      },
    };
    await registry.invoke("invoices", "get", { id: "inv_1" }, { tracer });
    await registry.invoke("invoices", "get", { id: "missing" }, { tracer }).catch(() => undefined);
    expect(spans.map((s) => [s.name, s.exceptions.length, s.ended])).toEqual([
      ["operation invoices.get", 0, true],
      ["operation invoices.get", 1, true],
    ]);
  });
});

describe("view tokens", () => {
  const keyed = createRegistry([invoices], { requestStateKey: "view-token-test-request-state-key-32b" });
  const alice = { id: "alice", scopes: [] };

  it("names the view they were minted for, for the caller they were minted for only", async () => {
    const token = await keyed.mintViewToken("invoices/browser", { principal: alice });
    expect(token).toBeTypeOf("string");
    await expect(keyed.openViewToken(token ?? "", { principal: alice })).resolves.toBe("invoices/browser");
    await expect(keyed.openViewToken(token ?? "", { principal: { id: "bob", scopes: [] } })).rejects.toMatchObject({
      kind: "validation",
    });
    await expect(keyed.openViewToken(token ?? "", { principal: alice, tenant: { id: "other" } })).rejects.toMatchObject(
      { kind: "validation" },
    );
  });

  it("are not request state, and are not minted without a requestStateKey", async () => {
    const token = await keyed.mintViewToken("invoices/browser");
    await expect(keyed.checkRequestState(token ?? "")).rejects.toMatchObject({ kind: "validation" });
    await expect(registry.mintViewToken("invoices/browser")).resolves.toBeUndefined();
  });
});

describe("resources", () => {
  it("reads a resource with its template parameters", async () => {
    await expect(registry.read("invoices", "invoice", { id: "inv_1" })).resolves.toEqual({
      id: "inv_1",
      totalCents: 900,
    });
  });

  it("requires every template parameter", async () => {
    await expect(registry.read("invoices", "invoice", {})).rejects.toMatchObject({
      kind: "validation",
      issues: [{ path: "id" }],
    });
  });

  it("validates resource output", async () => {
    await expect(registry.read("invoices", "invoice", { id: "broken" })).rejects.toMatchObject({ kind: "internal" });
  });

  it("reports unknown resources as not found", async () => {
    await expect(registry.read("invoices", "nope", {})).rejects.toMatchObject({ kind: "not_found" });
  });
});
