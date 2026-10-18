import { createRegistry, defineApp, op } from "@syrinx/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRestApp } from "./index.js";

const invoices = defineApp({
  name: "invoices",
  version: "1.0.0",
  description: "Look up and send customer invoices.",
  operations: {
    get: op({
      description: "Fetch one invoice by id.",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), status: z.enum(["draft", "sent"]) }),
      annotations: { readOnly: true },
      handler: ({ id }) => ({ id, status: "draft" as const }),
    }),
    send: op({
      description: "Email a draft invoice to its customer.",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), key: z.string().optional() }),
      visibility: ["model", "app", "rest"],
      handler: ({ id }, ctx) => ({ id, key: ctx.idempotencyKey }),
    }),
    preview: op({
      description: "Render a draft for the invoice view; not part of the public API.",
      input: z.object({ id: z.string() }),
      output: z.object({ html: z.string() }),
      visibility: ["app"],
      handler: () => ({ html: "<p>draft</p>" }),
    }),
  },
});

const app = createRestApp({ registry: createRegistry([invoices]) });
const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

describe("REST surface", () => {
  it("lists apps and describes each one", async () => {
    expect(await (await app.request("/api")).json()).toEqual({
      apps: [{ name: "invoices", version: "1.0.0", href: "/api/invoices" }],
    });
    const manifest = (await (await app.request("/api/invoices")).json()) as { operations: { name: string }[] };
    expect(manifest.operations.map((o) => o.name)).toEqual(["get", "send"]);
  });

  it("invokes an operation and wraps the result in the envelope", async () => {
    const res = await post("/api/invoices/ops/get", JSON.stringify({ id: "inv_1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resultType: "complete", data: { id: "inv_1", status: "draft" } });
  });

  it("passes the Idempotency-Key header to the handler", async () => {
    const res = await post("/api/invoices/ops/send", JSON.stringify({ id: "inv_1" }), { "idempotency-key": "k1" });
    expect(((await res.json()) as { data: unknown }).data).toEqual({ id: "inv_1", key: "k1" });
  });

  it("hides operations that are not visible on REST", async () => {
    expect((await post("/api/invoices/ops/preview", JSON.stringify({ id: "inv_1" }))).status).toBe(404);
    expect((await app.request("/api/invoices/ops/preview?id=inv_1")).status).toBe(404);
  });

  it("allows GET only for read-only operations", async () => {
    expect((await app.request("/api/invoices/ops/get?id=inv_2")).status).toBe(200);
    expect((await app.request("/api/invoices/ops/send?id=inv_2")).status).toBe(405);
  });

  it("returns validation failures as problem+json with field issues", async () => {
    const res = await post("/api/invoices/ops/get", JSON.stringify({ id: 3 }));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ type: "urn:syrinx:problem:validation", errors: [{ path: "id" }] });
  });

  it("rejects malformed JSON", async () => {
    expect((await post("/api/invoices/ops/get", "{")).status).toBe(400);
  });

  it("returns 404 problems for unknown apps, operations and routes", async () => {
    expect((await app.request("/api/nope")).status).toBe(404);
    expect((await post("/api/invoices/ops/nope", "{}")).status).toBe(404);
    const res = await app.request("/elsewhere");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });
});
