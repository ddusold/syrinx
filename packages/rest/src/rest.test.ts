import {
  createMemoryIdempotencyStore,
  createRegistry,
  defineApp,
  errors,
  noopLogger,
  op,
  prompt,
  resource,
  type Attributes,
  type Logger,
} from "@syrinx/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenApiDocument, createRestApp, type OpenApiDocument } from "./index.js";

const Invoice = z.object({ id: z.string(), status: z.enum(["draft", "sent"]) });
let sent = 0;

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
      handler: ({ id }) => ({ id, status: "draft" as const }),
    }),
    search: op({
      description: "Search invoices.",
      input: z.object({
        limit: z.number().int().optional(),
        paid: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
        q: z.string().optional(),
      }),
      output: z.object({ echo: z.unknown() }),
      annotations: { readOnly: true },
      handler: (input) => ({ echo: input }),
    }),
    send: op({
      description: "Email a draft invoice to its customer.",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), key: z.string().optional(), count: z.number() }),
      visibility: ["model", "app", "rest"],
      handler: ({ id }, ctx) => ({ id, key: ctx.idempotencyKey, count: ++sent }),
    }),
    void: op({
      description: "Void an invoice after confirmation.",
      input: z.object({ id: z.string() }),
      output: z.object({ voided: z.boolean() }),
      annotations: { asks: true },
      visibility: ["rest"],
      handler: async ({ id }, ctx) => ({ voided: await ctx.confirm(`Void ${id}?`) }),
    }),
    whoami: op({
      description: "Return the caller.",
      input: z.object({}),
      output: z.object({ principal: z.string(), tenant: z.string().optional() }),
      annotations: { readOnly: true },
      permissions: ["me:read"],
      handler: (_input, ctx) => ({ principal: ctx.principal.id, tenant: ctx.tenant?.id }),
    }),
    preview: op({
      description: "Render a draft for the invoice view; not part of the public API.",
      input: z.object({ id: z.string() }),
      output: z.object({ html: z.string() }),
      visibility: ["app"],
      handler: () => ({ html: "<p>draft</p>" }),
    }),
  },
  resources: {
    invoice: resource({
      uri: "invoice://{id}",
      description: "One invoice.",
      output: Invoice,
      read: ({ id }, ctx) => {
        if (id === "missing") throw ctx.errors.notFound(`No invoice ${id}.`);
        return { id, status: "sent" as const };
      },
    }),
    line: resource({
      uri: "invoice://{id}/lines/{line}",
      output: z.object({ id: z.string(), line: z.string() }),
      complete: { line: (value) => ["1", "2", "10"].filter((l) => l.startsWith(value)) },
      read: (params) => params,
    }),
  },
  prompts: {
    remind: prompt({
      description: "Draft a reminder after asking which tone to use.",
      args: z.object({ id: z.string().describe("Invoice id.") }),
      asks: true,
      render: async ({ id }, ctx) => {
        const answer = await ctx.ask("Which tone?", z.object({ tone: z.string() }), { key: "tone" });
        return `Remind about ${id} in a ${answer?.tone ?? "neutral"} tone.`;
      },
    }),
  },
});

const registry = createRegistry([invoices], {
  requestStateKey: "rest-test-request-state-key-32-bytes!",
  idempotency: createMemoryIdempotencyStore(),
});
const app = createRestApp({
  registry,
  authenticate: (request) => {
    const auth = request.headers.get("authorization");
    if (!auth) return undefined;
    if (auth !== "Bearer good") throw errors.unauthenticated("Invalid token.");
    return { id: "user_1", scopes: ["me:read"] };
  },
  resolveTenant: (_principal, request) => {
    const tenant = request.headers.get("x-tenant");
    return tenant ? { id: tenant } : undefined;
  },
  openapi: { title: "Test API", version: "9.9.9" },
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

describe("catalog and manifests", () => {
  it("lists apps and describes each one with schemas and resources", async () => {
    expect(await json(await app.request("/api"))).toEqual({
      apps: [{ name: "invoices", version: "1.0.0", href: "/api/invoices" }],
    });
    const manifest = await json<{
      operations: { name: string }[];
      resources: { name: string; href?: string }[];
    }>(await app.request("/api/invoices"));
    // Anonymous callers do not see whoami, which needs me:read; the signed-in caller does, in a private response.
    expect(manifest.operations.map((o) => o.name)).toEqual(["get", "search", "send", "void"]);
    const signedIn = await app.request("/api/invoices", { headers: { authorization: "Bearer good" } });
    expect(signedIn.headers.get("cache-control")).toBe("private");
    expect((await json<{ operations: { name: string }[] }>(signedIn)).operations.map((o) => o.name)).toContain(
      "whoami",
    );
    expect(manifest.operations[0]).toMatchObject({
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      outputSchema: { properties: { status: { enum: ["draft", "sent"] } } },
    });
    expect(manifest.resources).toEqual([
      expect.objectContaining({ name: "invoice", uri: "invoice://{id}", href: "/api/invoices/resources/invoice/{id}" }),
      expect.objectContaining({ name: "line", href: "/api/invoices/resources/invoice/{id}/lines/{line}" }),
    ]);
  });

  it("serves ETags and answers revalidation with 304", async () => {
    const first = await app.request("/api/invoices");
    const tag = first.headers.get("etag");
    expect(tag).toBeTruthy();
    const second = await app.request("/api/invoices", { headers: { "if-none-match": tag ?? "" } });
    expect(second.status).toBe(304);
  });
});

describe("operations", () => {
  it("wraps results in the envelope with request metadata", async () => {
    const res = await post("/api/invoices/ops/get", { id: "inv_1" }, { "x-request-id": "req_1" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      resultType: "complete",
      data: { id: "inv_1", status: "draft" },
      meta: { requestId: "req_1" },
    });
  });

  it("reports the trace id from traceparent", async () => {
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const res = await post("/api/invoices/ops/get", { id: "inv_1" }, { traceparent });
    expect(await json(res)).toMatchObject({ meta: { traceId: "0af7651916cd43dd8448eb211c80319c" } });
  });

  it("replays writes for a repeated Idempotency-Key and marks the replay", async () => {
    const headers = { "idempotency-key": "rest-k1" };
    const first = await json<{ data: { count: number } }>(await post("/api/invoices/ops/send", { id: "1" }, headers));
    const again = await json<{ data: unknown; meta: unknown }>(
      await post("/api/invoices/ops/send", { id: "1" }, headers),
    );
    expect(again.data).toEqual(first.data);
    expect(again.meta).toMatchObject({ replayed: true });
    expect((await post("/api/invoices/ops/send", { id: "2" }, headers)).status).toBe(422);
  });

  it("asks for input and resumes with the answers", async () => {
    const first = await json<{ resultType: string; inputRequests: unknown; requestState: string }>(
      await post("/api/invoices/ops/void", { id: "inv_1" }),
    );
    expect(first).toMatchObject({
      resultType: "input_required",
      inputRequests: { "input-0": { kind: "confirm", message: "Void inv_1?" } },
      meta: { requestId: expect.any(String) as string },
    });
    const resumed = await post("/api/invoices/ops/void/resume", {
      input: { id: "inv_1" },
      requestState: first.requestState,
      inputResponses: { "input-0": { action: "accept" } },
    });
    expect(await json(resumed)).toMatchObject({ resultType: "complete", data: { voided: true } });
    expect((await post("/api/invoices/ops/void/resume", { input: { id: "inv_1" } })).status).toBe(400);
  });

  it("hides operations that are not visible on REST", async () => {
    expect((await post("/api/invoices/ops/preview", { id: "inv_1" })).status).toBe(404);
    expect((await app.request("/api/invoices/ops/preview?id=inv_1")).status).toBe(404);
  });

  it("allows GET only for read-only operations", async () => {
    expect((await app.request("/api/invoices/ops/get?id=inv_2")).status).toBe(200);
    const res = await app.request("/api/invoices/ops/send?id=inv_2");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("types GET input from the query string using the input schema", async () => {
    const res = await app.request("/api/invoices/ops/search?limit=5&paid=true&tags=a&tags=b&q=42");
    expect(await json(res)).toMatchObject({ data: { echo: { limit: 5, paid: true, tags: ["a", "b"], q: "42" } } });
    const bad = await app.request("/api/invoices/ops/search?limit=five");
    expect(await json(bad)).toMatchObject({ errors: [{ path: "limit" }] });
  });
});

describe("resources", () => {
  it("reads resources by URI path, decoding template variables", async () => {
    expect(await json(await app.request("/api/invoices/resources/invoice/inv%2F1"))).toMatchObject({
      resultType: "complete",
      data: { id: "inv/1", status: "sent" },
    });
    expect(await json(await app.request("/api/invoices/resources/invoice/inv_1/lines/2"))).toMatchObject({
      data: { id: "inv_1", line: "2" },
    });
  });

  it("returns 404 for unknown and missing resources", async () => {
    expect((await app.request("/api/invoices/resources/invoice/missing")).status).toBe(404);
    expect((await app.request("/api/invoices/resources/other/x")).status).toBe(404);
  });
});

describe("authentication and tenants", () => {
  it("passes the authenticated principal and resolved tenant to handlers", async () => {
    const res = await app.request("/api/invoices/ops/whoami", {
      headers: { authorization: "Bearer good", "x-tenant": "acme" },
    });
    expect(await json(res)).toMatchObject({ data: { principal: "user_1", tenant: "acme" } });
  });

  it("answers anonymous callers with 401 and a challenge, and bad tokens with 401", async () => {
    const anonymous = await app.request("/api/invoices/ops/whoami");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
    expect((await app.request("/api/invoices/ops/whoami", { headers: { authorization: "Bearer bad" } })).status).toBe(
      401,
    );
  });

  it("serves anonymous discovery by default outside production", async () => {
    expect((await app.request("/openapi.json")).status).toBe(200);
    expect((await app.request("/api")).status).toBe(200);
  });

  it("with requireAuth, refuses anonymous callers everywhere but /healthz, authenticating once", async () => {
    const authenticate = vi.fn((request: Request) =>
      request.headers.get("authorization") === "Bearer good" ? { id: "user_1", scopes: ["me:read"] } : undefined,
    );
    const strict = createRestApp({ registry, authenticate, requireAuth: true });
    strict.get("/mcp", (c) => c.text("mounted by the host"));
    for (const path of ["/openapi.json", "/api", "/api/invoices", "/api/invoices/openapi.json", "/api/nope"]) {
      const res = await strict.request(path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("www-authenticate"), path).toBe("Bearer");
    }
    expect((await strict.request("/healthz")).status).toBe(200);
    expect((await strict.request("/mcp")).status).toBe(200);
    expect((await strict.request("/api/invoices/ops/whoami", { method: "OPTIONS" })).status).not.toBe(401);
    const refused = await strict.request("/api", { headers: { "x-request-id": "req_9" } });
    expect(await json(refused)).toMatchObject({ requestId: "req_9" });
    authenticate.mockClear();
    const res = await strict.request("/api/invoices/ops/whoami", { headers: { authorization: "Bearer good" } });
    expect(await json(res)).toMatchObject({ data: { principal: "user_1" } });
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it("lets every caller through as the local principal with SYRINX_LOCAL_BYPASS_AUTH", async () => {
    vi.stubEnv("SYRINX_LOCAL_BYPASS_AUTH", "1");
    try {
      const open = createRestApp({ registry, requireAuth: true });
      expect(await json(await open.request("/api/invoices/ops/whoami"))).toMatchObject({
        data: { principal: "local" },
      });
      const local = { host: "localhost:3000", origin: "http://localhost:5173" };
      expect((await open.request("/api/invoices/ops/whoami", { headers: local })).status).toBe(200);
      const crossSite = await open.request("/api/invoices/ops/whoami", {
        method: "POST",
        headers: { host: "localhost:3000", origin: "https://evil.example", "content-type": "text/plain" },
        body: "{}",
      });
      expect(crossSite.status).toBe(403);
      const rebound = await open.request("/api/invoices/ops/whoami", { headers: { host: "evil.example" } });
      expect(rebound.status).toBe(403);
      vi.stubEnv("NODE_ENV", "production");
      expect(() => createRestApp({ registry, requireAuth: false })).toThrow(/not allowed in production/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("defaults requireAuth on in production, and refuses it without authenticate", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => createRestApp({ registry })).toThrow(/requireAuth is on \(the default/);
      expect(() => createRestApp({ registry, requireAuth: false })).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(() => createRestApp({ registry, requireAuth: true })).toThrow(/no authenticate/);
  });
});

describe("problems", () => {
  it("returns validation failures as problem+json with field issues and the request id", async () => {
    const res = await post("/api/invoices/ops/get", { id: 3 }, { "x-request-id": "req_2" });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await json(res)).toMatchObject({
      type: "https://ddusold.github.io/syrinx/problems/validation",
      requestId: "req_2",
      errors: [{ path: "id" }],
    });
  });

  it("rejects malformed JSON", async () => {
    expect((await post("/api/invoices/ops/get", "{")).status).toBe(400);
  });

  it("returns 404 problems for unknown apps, operations and routes", async () => {
    expect((await app.request("/api/nope")).status).toBe(404);
    expect((await post("/api/invoices/ops/nope", {})).status).toBe(404);
    const res = await app.request("/elsewhere");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });
});

describe("unhandled errors", () => {
  const broken = defineApp({
    name: "broken",
    version: "1.0.0",
    description: "Fails on purpose.",
    operations: {
      explode: op({
        description: "Throw a plain error.",
        input: z.object({}),
        output: z.object({}),
        annotations: { readOnly: true },
        handler: () => {
          throw new TypeError("boom");
        },
      }),
      misshape: op({
        description: "Return output that breaks its schema.",
        input: z.object({}),
        output: z.object({ id: z.string() }),
        annotations: { readOnly: true },
        handler: () => ({ id: 1 }) as unknown as { id: string },
      }),
      refuse: op({
        description: "Throw a Syrinx error.",
        input: z.object({}),
        output: z.object({}),
        annotations: { readOnly: true },
        handler: () => {
          throw errors.conflict("Already sent.");
        },
      }),
    },
  });
  const brokenRegistry = createRegistry([broken], { idempotency: false });
  const authenticate = (request: Request) => {
    if (request.headers.get("authorization")) throw new Error("auth backend down");
    return undefined;
  };
  const capture = () => {
    const entries: { message: string; attributes: Attributes | undefined }[] = [];
    const logger: Logger = { ...noopLogger, error: (message, attributes) => entries.push({ message, attributes }) };
    return { entries, logger };
  };
  const call = (logger: Logger | false | undefined, path = "/api/broken/ops/explode", headers = {}) =>
    createRestApp({ registry: brokenRegistry, authenticate, ...(logger !== undefined ? { logger } : {}) }).request(
      path,
      {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json", "x-request-id": "req_9", ...headers },
      },
    );

  it("logs the cause, stack and request context, and answers with a bare 500", async () => {
    const { entries, logger } = capture();
    const res = await call(logger);
    expect(res.status).toBe(500);
    expect(await json(res)).toMatchObject({ detail: "Internal error", requestId: "req_9" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      message: "unhandled error",
      attributes: {
        "syrinx.surface": "rest",
        "syrinx.request_id": "req_9",
        "syrinx.app": "broken",
        "syrinx.operation": "explode",
        "http.request.method": "POST",
        "error.type": "TypeError",
        "error.message": "boom",
        "error.stack": expect.stringContaining("TypeError: boom") as string,
      },
    });
  });

  it("logs errors thrown by surface hooks such as authenticate", async () => {
    const { entries, logger } = capture();
    expect((await call(logger, "/api/broken/ops/explode", { authorization: "Bearer x" })).status).toBe(500);
    expect(entries[0]?.attributes).toMatchObject({
      "error.message": "auth backend down",
      "syrinx.request_id": "req_9",
    });
  });

  it("logs internal Syrinx errors, which are server bugs too", async () => {
    const { entries, logger } = capture();
    expect((await call(logger, "/api/broken/ops/misshape")).status).toBe(500);
    expect(entries[0]?.attributes).toMatchObject({ "syrinx.operation": "misshape", "error.type": "SyrinxError" });
  });

  it("does not log Syrinx errors, which the client already sees", async () => {
    const { entries, logger } = capture();
    expect((await call(logger, "/api/broken/ops/refuse")).status).toBe(409);
    expect(entries).toEqual([]);
  });

  it("falls back to console.error without a logger, and stays quiet with logger: false", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await call(undefined);
      expect(spy).toHaveBeenCalledWith(
        "syrinx: unhandled error",
        expect.objectContaining({ "syrinx.request_id": "req_9" }),
        expect.any(TypeError),
      );
      spy.mockClear();
      await call(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("OpenAPI", () => {
  it("serves an aggregate document and one per app", async () => {
    const doc = await json<{ info: unknown; paths: Record<string, unknown> }>(await app.request("/openapi.json"));
    expect(doc.info).toMatchObject({ title: "Test API", version: "9.9.9" });
    expect(Object.keys(doc.paths)).toContain("/api/invoices/ops/void/resume");
    expect(Object.keys(doc.paths)).not.toContain("/api/invoices/ops/get/resume");
    expect(Object.keys(doc.paths)).not.toContain("/api/invoices/ops/preview");
    expect((await app.request("/api/invoices/openapi.json")).status).toBe(200);
  });

  it("advertises Idempotency-Key on writes only while the registry deduplicates", () => {
    const params = (doc: OpenApiDocument, path: string) =>
      (doc.paths[path] as { post: { parameters: { name: string }[] } }).post.parameters.map((p) => p.name);
    const on = createOpenApiDocument(createRegistry([invoices]));
    expect(params(on, "/api/invoices/ops/void")).toContain("Idempotency-Key");
    expect(params(on, "/api/invoices/ops/get")).not.toContain("Idempotency-Key");
    const off = createOpenApiDocument(createRegistry([invoices], { idempotency: false }));
    expect(params(off, "/api/invoices/ops/void")).not.toContain("Idempotency-Key");
  });
});

describe("prompts and completion", () => {
  it("renders prompts that ask, resuming with the answer", async () => {
    const asked = await json<{ resultType: string; requestState: string; inputRequests: unknown }>(
      await post("/api/invoices/prompts/remind", { id: "inv_1" }),
    );
    expect(asked).toMatchObject({ resultType: "input_required", inputRequests: { tone: { kind: "ask" } } });
    const done = await post("/api/invoices/prompts/remind/resume", {
      input: { id: "inv_1" },
      requestState: asked.requestState,
      inputResponses: { tone: { action: "accept", content: { tone: "warm" } } },
    });
    expect(await json(done)).toMatchObject({
      resultType: "complete",
      data: { messages: [{ role: "user", content: { type: "text", text: "Remind about inv_1 in a warm tone." } }] },
    });
  });

  it("suggests resource template variables", async () => {
    const res = await post("/api/invoices/complete", { resource: "line", argument: "line", value: "1" });
    expect(await json(res)).toMatchObject({ data: { values: ["1", "10"], total: 2, hasMore: false } });
    expect((await post("/api/invoices/complete", { argument: "line" })).status).toBe(400);
  });
});
