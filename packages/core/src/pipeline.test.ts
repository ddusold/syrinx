import { describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "./crypto.js";
import { z } from "zod";
import {
  createMemoryIdempotencyStore,
  createRegistry,
  defineApp,
  noopLogger,
  op,
  resource,
  type AuditRecord,
  type IdempotencyStore,
  type InvokeResult,
  type RegistryOptions,
} from "./index.js";

const KEY = "test-request-state-key-of-32-bytes!!";
const reader = { id: "reader", scopes: ["invoices:read"] };
const writer = { id: "writer", scopes: ["invoices:read", "invoices:write"] };

let sends = 0;
let failNext: "internal" | "not_found" | undefined;

const invoices = defineApp({
  name: "invoices",
  version: "1",
  description: "Invoices.",
  operations: {
    get: op({
      description: "Fetch one invoice.",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      annotations: { readOnly: true },
      permissions: ["invoices:read"],
      handler: ({ id }) => ({ id }),
    }),
    send: op({
      description: "Send an invoice.",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), count: z.number() }),
      visibility: ["rest"],
      permissions: (principal, { id }) => principal.scopes.includes("invoices:write") && id !== "locked",
      handler: ({ id }, ctx) => {
        if (failNext) {
          const kind = failNext;
          failNext = undefined;
          throw kind === "internal" ? new Error("boom") : ctx.errors.notFound(`No invoice ${id}.`);
        }
        return { id, count: ++sends };
      },
    }),
    void: op({
      description: "Void an invoice after confirmation.",
      input: z.object({ id: z.string() }),
      output: z.object({ voided: z.boolean(), reason: z.string().optional() }),
      annotations: { asks: true },
      visibility: ["rest"],
      handler: async ({ id }, ctx) => {
        if (!(await ctx.confirm(`Void invoice ${id}?`))) return { voided: false };
        const answer = await ctx.ask("Why?", z.object({ reason: z.string().min(3) }));
        return answer ? { voided: true, reason: answer.reason } : { voided: true };
      },
    }),
    sneaky: op({
      description: "Catches the input signal by mistake.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      annotations: { asks: true },
      visibility: ["rest"],
      handler: async (_input, ctx) => {
        try {
          await ctx.confirm("Sure?");
        } catch {
          // swallowed
        }
        return { ok: true };
      },
    }),
  },
  resources: {
    invoice: resource({
      uri: "invoice://{id}",
      output: z.object({ id: z.string() }),
      permissions: ["invoices:read"],
      read: async ({ id }, ctx) => {
        await ctx.confirm("Read?");
        return { id };
      },
    }),
  },
});

const registry = (options: RegistryOptions = {}) => createRegistry([invoices], { requestStateKey: KEY, ...options });

const inputRequired = (result: InvokeResult) => {
  if (result.resultType !== "input_required") throw new Error(`expected input_required, got ${result.resultType}`);
  return result;
};

describe("permissions", () => {
  it("asks anonymous callers to authenticate and forbids principals without the scope", async () => {
    const r = registry();
    await expect(r.invoke("invoices", "get", { id: "1" })).rejects.toMatchObject({ kind: "unauthenticated" });
    await expect(
      r.invoke("invoices", "get", { id: "1" }, { principal: { id: "u", scopes: [] } }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(r.invoke("invoices", "get", { id: "1" }, { principal: reader })).resolves.toMatchObject({
      data: { id: "1" },
    });
  });

  it("checks scopes before validating input, so unauthorized callers learn nothing about the schema", async () => {
    await expect(registry().invoke("invoices", "get", { id: 7 })).rejects.toMatchObject({ kind: "unauthenticated" });
  });

  it("runs predicates against validated input", async () => {
    const r = registry();
    await expect(r.invoke("invoices", "send", { id: "locked" }, { principal: writer })).rejects.toMatchObject({
      kind: "forbidden",
    });
    await expect(r.invoke("invoices", "send", { id: "1" }, { principal: reader })).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("applies to resources too", async () => {
    await expect(registry().read("invoices", "invoice", { id: "1" })).rejects.toMatchObject({
      kind: "unauthenticated",
    });
  });
});

describe("tenant enablement", () => {
  it("reports disabled operations and resources as not found", async () => {
    const r = registry({ isEnabled: (target, tenant) => tenant?.id !== "t2" || target.operation === "get" });
    const options = { principal: writer, tenant: { id: "t2" } };
    await expect(r.invoke("invoices", "get", { id: "1" }, options)).resolves.toBeDefined();
    await expect(r.invoke("invoices", "send", { id: "1" }, options)).rejects.toMatchObject({ kind: "not_found" });
    await expect(r.read("invoices", "invoice", { id: "1" }, options)).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("idempotency", () => {
  const call = (r: ReturnType<typeof registry>, id: string, key?: string) =>
    r.invoke("invoices", "send", { id }, { principal: writer, ...(key ? { idempotencyKey: key } : {}) });

  it("replays the first outcome for a repeated key", async () => {
    const r = registry({ idempotency: createMemoryIdempotencyStore() });
    const first = await call(r, "1", "k1");
    const second = await call(r, "1", "k1");
    expect(second).toEqual({ ...first, replayed: true });
    expect(await call(r, "1")).not.toEqual(first); // no key, no dedupe
  });

  it("rejects a key reused with a different request", async () => {
    const r = registry({ idempotency: createMemoryIdempotencyStore() });
    await call(r, "1", "k2");
    await expect(call(r, "2", "k2")).rejects.toMatchObject({ kind: "unprocessable", status: 422 });
  });

  it("keys per principal, so two callers never share an outcome", async () => {
    const r = registry({ idempotency: createMemoryIdempotencyStore() });
    await call(r, "1", "shared");
    const other = { id: "other", scopes: writer.scopes };
    await expect(
      r.invoke("invoices", "send", { id: "1" }, { principal: other, idempotencyKey: "shared" }),
    ).resolves.not.toHaveProperty("replayed");
  });

  it("stores domain errors but releases the key after transient failures", async () => {
    const r = registry({ idempotency: createMemoryIdempotencyStore() });
    failNext = "not_found";
    await expect(call(r, "1", "k3")).rejects.toMatchObject({ kind: "not_found" });
    await expect(call(r, "1", "k3")).rejects.toMatchObject({ kind: "not_found" });

    failNext = "internal";
    await expect(call(r, "1", "k4")).rejects.toThrow("boom");
    await expect(call(r, "1", "k4")).resolves.toMatchObject({ resultType: "complete" });
  });

  it("deduplicates in memory by default, and not at all with idempotency: false", async () => {
    const r = registry();
    expect(r.idempotent).toBe(true);
    const first = await call(r, "1", "k6");
    expect(await call(r, "1", "k6")).toEqual({ ...first, replayed: true });

    const off = registry({ idempotency: false });
    expect(off.idempotent).toBe(false);
    await call(off, "1", "k7");
    await expect(call(off, "1", "k7")).resolves.not.toHaveProperty("replayed");
    await expect(call(off, "2", "k7")).resolves.toMatchObject({ resultType: "complete" });
  });

  it("answers with the result when the store fails to record it, and keeps the key claimed", async () => {
    const memory = createMemoryIdempotencyStore();
    const flaky: IdempotencyStore = {
      begin: (key, fingerprint) => memory.begin(key, fingerprint),
      complete: () => Promise.reject(new Error("connection reset")),
      release: (key, token) => memory.release(key, token),
    };
    const errorLog = vi.fn();
    const logger = { ...noopLogger, error: errorLog };
    const r = registry({ idempotency: flaky });
    const send = () => r.invoke("invoices", "send", { id: "1" }, { principal: writer, idempotencyKey: "k8", logger });
    await expect(send()).resolves.toMatchObject({ resultType: "complete" });
    expect(errorLog).toHaveBeenCalledWith(
      "idempotency store complete failed",
      expect.objectContaining({ "error.message": "connection reset" }),
    );
    // Not released, so the retry cannot send the invoice again.
    await expect(send()).rejects.toMatchObject({ kind: "conflict" });
  });

  it("warns in production when writes fall back to the memory store", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "production");
    try {
      registry();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toMatch(/other instances do not see them/);
      registry({ idempotency: false });
      registry({ idempotency: createMemoryIdempotencyStore() });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
      warn.mockRestore();
    }
  });

  it("refuses a key whose first request is still running", async () => {
    const store = createMemoryIdempotencyStore();
    await store.begin("/writer/invoices.send/k5", await sha256(canonicalJson({ id: "1" })));
    const r = registry({ idempotency: store });
    await expect(call(r, "1", "k5")).rejects.toMatchObject({ kind: "conflict" });
  });
});

describe("audit", () => {
  it("records every write with its outcome, and skips reads", async () => {
    const records: AuditRecord[] = [];
    const r = registry({ audit: (record) => void records.push(record) });
    await r.invoke("invoices", "get", { id: "1" }, { principal: reader });
    await r.invoke("invoices", "send", { id: "1" }, { principal: writer, requestId: "req_1", surface: "rest" });
    await r.invoke("invoices", "send", { id: "locked" }, { principal: writer }).catch(() => undefined);
    await r.invoke("invoices", "void", { id: "1" });
    expect(records.map((x) => [x.operation, x.outcome])).toEqual([
      ["send", "complete"],
      ["send", "forbidden"],
      ["void", "input_required"],
    ]);
    expect(records[0]).toMatchObject({ requestId: "req_1", surface: "rest", principal: "writer" });
  });

  it("logs a failing audit hook without failing the write", async () => {
    const error = vi.fn();
    const r = registry({
      audit: () => {
        throw new Error("audit down");
      },
    });
    await expect(
      r.invoke("invoices", "send", { id: "1" }, { principal: writer, logger: { ...noopLogger, error } }),
    ).resolves.toMatchObject({ resultType: "complete" });
    expect(error).toHaveBeenCalledWith("audit hook failed", expect.objectContaining({ error: "Error: audit down" }));
  });
});

describe("input round trips", () => {
  const voidCall = (r: ReturnType<typeof registry>, resume?: { requestState: string; inputResponses: object }) =>
    r.invoke(
      "invoices",
      "void",
      { id: "inv_1" },
      resume ? { resume: { ...resume, inputResponses: { ...resume.inputResponses } } } : {},
    );

  it("asks, then re-runs the handler with each answer until it completes", async () => {
    const r = registry();
    const first = inputRequired(await voidCall(r));
    expect(first.inputRequests).toEqual({ "input-0": { kind: "confirm", message: "Void invoice inv_1?" } });

    const second = inputRequired(
      await voidCall(r, { requestState: first.requestState, inputResponses: { "input-0": { action: "accept" } } }),
    );
    expect(second.inputRequests).toMatchObject({
      "input-1": { kind: "ask", message: "Why?", schema: { properties: { reason: { type: "string", minLength: 3 } } } },
    });

    const done = await voidCall(r, {
      requestState: second.requestState,
      inputResponses: { "input-1": { action: "accept", content: { reason: "duplicate" } } },
    });
    expect(done).toEqual({ resultType: "complete", data: { voided: true, reason: "duplicate" } });
  });

  it("treats decline as false for confirm and undefined for ask", async () => {
    const r = registry();
    const first = inputRequired(await voidCall(r));
    await expect(
      voidCall(r, { requestState: first.requestState, inputResponses: { "input-0": { action: "decline" } } }),
    ).resolves.toEqual({ resultType: "complete", data: { voided: false } });
  });

  it("validates ask answers against their schema", async () => {
    const r = registry();
    const first = inputRequired(await voidCall(r));
    const second = inputRequired(
      await voidCall(r, { requestState: first.requestState, inputResponses: { "input-0": { action: "accept" } } }),
    );
    await expect(
      voidCall(r, {
        requestState: second.requestState,
        inputResponses: { "input-1": { action: "accept", content: { reason: "no" } } },
      }),
    ).rejects.toMatchObject({ kind: "validation", issues: [{ path: "reason" }] });
  });

  it("rejects request state that was tampered with or reused for other input, and re-asks unanswered questions", async () => {
    const r = registry();
    const { requestState } = inputRequired(await voidCall(r));
    const accept = { "input-0": { action: "accept" } };
    await expect(voidCall(r, { requestState: `${requestState}x`, inputResponses: accept })).rejects.toMatchObject({
      kind: "validation",
      message: /not valid/,
      issues: [{ path: "requestState" }],
    });
    await expect(
      r.invoke("invoices", "void", { id: "other" }, { resume: { requestState, inputResponses: accept } }),
    ).rejects.toMatchObject({ message: /different call/ });
    await expect(
      r.invoke(
        "invoices",
        "void",
        { id: "inv_1" },
        { principal: writer, resume: { requestState, inputResponses: accept } },
      ),
    ).rejects.toMatchObject({ message: /different call/ });
    const again = inputRequired(
      await voidCall(r, { requestState, inputResponses: { "input-9": { action: "accept" } } }),
    );
    expect(again.inputRequests).toEqual({ "input-0": { kind: "confirm", message: "Void invoice inv_1?" } });
  });

  it("rejects expired request state", async () => {
    const r = registry({ requestStateTtlSeconds: -1 });
    const { requestState } = inputRequired(await voidCall(r));
    await expect(
      voidCall(r, { requestState, inputResponses: { "input-0": { action: "accept" } } }),
    ).rejects.toMatchObject({ message: /expired/ });
  });

  it("still asks when a handler swallows the input signal", async () => {
    const result = await registry().invoke("invoices", "sneaky", {});
    expect(result.resultType).toBe("input_required");
  });

  it("explains a missing signing key instead of failing obscurely", async () => {
    await expect(createRegistry([invoices]).invoke("invoices", "void", { id: "1" })).rejects.toMatchObject({
      kind: "internal",
      message: /no requestStateKey/,
    });
  });

  it("does not let resources ask", async () => {
    await expect(registry().read("invoices", "invoice", { id: "1" }, { principal: reader })).rejects.toMatchObject({
      kind: "internal",
      message: /cannot ask/,
    });
  });
});

describe("asks and declarative confirm", () => {
  let handled = 0;
  const archive = defineApp({
    name: "archive",
    version: "1",
    description: "Archive.",
    operations: {
      purge: op({
        description: "Purge an archive after confirmation.",
        input: z.object({ id: z.string(), force: z.boolean().optional() }),
        output: z.object({ purged: z.string() }),
        visibility: ["rest"],
        confirm: ({ id, force }) => (force ? undefined : `Purge ${id}?`),
        handler: ({ id }) => {
          handled++;
          return { purged: id };
        },
      }),
      undeclared: op({
        description: "Asks without declaring it.",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        visibility: ["rest"],
        handler: async (_input, ctx) => ({ ok: await ctx.confirm("Sure?") }),
      }),
    },
  });
  const r = createRegistry([archive], { requestStateKey: KEY });

  it("marks operations with a confirm hook as asking", () => {
    expect(archive.operations.purge.annotations.asks).toBe(true);
  });

  it("asks before the handler, then runs the handler exactly once", async () => {
    handled = 0;
    const asked = inputRequired(await r.invoke("archive", "purge", { id: "a1" }));
    expect(asked.inputRequests).toEqual({ "input-0": { kind: "confirm", message: "Purge a1?" } });
    expect(handled).toBe(0);
    const done = await r.invoke(
      "archive",
      "purge",
      { id: "a1" },
      {
        resume: { requestState: asked.requestState, inputResponses: { "input-0": { action: "accept" } } },
      },
    );
    expect(done).toEqual({ resultType: "complete", data: { purged: "a1" } });
    expect(handled).toBe(1);
  });

  it("fails as cancelled when declined, and skips the question when the hook returns undefined", async () => {
    const asked = inputRequired(await r.invoke("archive", "purge", { id: "a2" }));
    await expect(
      r.invoke(
        "archive",
        "purge",
        { id: "a2" },
        {
          resume: { requestState: asked.requestState, inputResponses: { "input-0": { action: "decline" } } },
        },
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });
    await expect(r.invoke("archive", "purge", { id: "a3", force: true })).resolves.toMatchObject({
      resultType: "complete",
    });
  });

  it("refuses ctx.confirm in operations that do not declare annotations.asks", async () => {
    await expect(r.invoke("archive", "undeclared", {})).rejects.toMatchObject({
      kind: "internal",
      message: /does not declare annotations.asks/,
    });
  });
});

describe("request state sealing", () => {
  const decode = (part: string) => atob(part.replaceAll("-", "+").replaceAll("_", "/"));

  it("is encrypted, so clients cannot read answers, principal or tenant", async () => {
    const { requestState } = inputRequired(
      await registry().invoke("invoices", "void", { id: "inv_secret" }, { principal: writer, tenant: { id: "acme" } }),
    );
    const plain = requestState.split(".").map(decode).join("");
    for (const secret of ["writer", "acme", "inv_secret", "Void invoice"]) expect(plain).not.toContain(secret);
  });

  it("opens state sealed with an older key while rotating, and rejects it once that key is dropped", async () => {
    const OLD = KEY;
    const NEW = "new-request-state-key-of-32-bytes!!!!";
    const { requestState } = inputRequired(
      await registry({ requestStateKey: OLD }).invoke("invoices", "void", { id: "r" }),
    );
    const resume = { requestState, inputResponses: { "input-0": { action: "decline" } } };

    await expect(
      registry({ requestStateKey: [NEW, OLD] }).invoke("invoices", "void", { id: "r" }, { resume }),
    ).resolves.toMatchObject({ resultType: "complete" });
    await expect(
      registry({ requestStateKey: [NEW] }).invoke("invoices", "void", { id: "r" }, { resume }),
    ).rejects.toMatchObject({ message: /not valid/ });
  });

  it("rejects keys shorter than 32 bytes", async () => {
    await expect(registry({ requestStateKey: "short" }).invoke("invoices", "void", { id: "x" })).rejects.toThrow(
      /at least 32 bytes/,
    );
  });
});

describe("interaction ids", () => {
  it("are shared by every round of one call and differ between calls", async () => {
    const records: AuditRecord[] = [];
    const r = registry({ audit: (record) => void records.push(record) });
    const asked = inputRequired(await r.invoke("invoices", "void", { id: "i1" }));
    await r.invoke(
      "invoices",
      "void",
      { id: "i1" },
      {
        resume: { requestState: asked.requestState, inputResponses: { "input-0": { action: "decline" } } },
      },
    );
    await r.invoke("invoices", "void", { id: "i2" });
    const [first, second, third] = records.map((x) => x.interactionId);
    expect(first).toBe(second);
    expect(third).not.toBe(first);
  });
});
