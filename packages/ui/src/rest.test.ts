// @vitest-environment happy-dom
import { defineApp, op } from "@syrinx/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { createRestBridge, createRestClient, restBoot } from "./rest.js";
import { ViewCallError } from "./types.js";

type Handler = (url: string, init: RequestInit) => { status?: number; body: unknown };

/** A fetch that records each request and answers from a handler. */
function fakeFetch(handler: Handler) {
  const requests: { url: string; init: RequestInit; json: unknown }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    requests.push({ url, init, json: JSON.parse(init.body as string) });
    const { status = 200, body } = handler(url, init);
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;
  return { fetchFn, requests };
}

const options = (fetchFn: typeof fetch) => ({
  base: "/api/contacts/ops",
  view: "contacts/profile",
  bound: { get: undefined, details: "details" },
  headers: () => ({ authorization: "Bearer t" }),
  fetch: fetchFn,
});
const target = (operation: string, extra: object = {}) => ({ app: "contacts", operation, ...extra });

describe("REST bridge", () => {
  it("posts operations by name with the page's headers, and tags bound results with the view and component", async () => {
    const { fetchFn, requests } = fakeFetch(() => ({ body: { resultType: "complete", data: { ok: 1 }, meta: {} } }));
    const bridge = createRestBridge(options(fetchFn));

    await expect(bridge.call("ignored", { personId: "p1" }, target("get"))).resolves.toEqual({
      data: { ok: 1 },
      view: { view: "contacts/profile", op: "get", schemaVersion: "" },
    });
    await expect(bridge.call("ignored", { personId: "p1" }, target("details"))).resolves.toMatchObject({
      view: { op: "details", component: "details" },
    });
    // Not bound: plain data, so the view is left alone.
    await expect(bridge.call("ignored", {}, target("list"))).resolves.toEqual({ data: { ok: 1 } });

    expect(requests[0]).toMatchObject({ url: "/api/contacts/ops/get", json: { personId: "p1" } });
    expect(requests[0]?.init).toMatchObject({ method: "POST" });
    expect(requests[0]?.init.headers).toMatchObject({ authorization: "Bearer t", "content-type": "application/json" });
  });

  it("turns RFC 9457 problems and network failures into view call errors", async () => {
    const problem = fakeFetch(() => ({
      status: 422,
      body: {
        type: "x/validation",
        title: "validation",
        detail: "Bad input.",
        errors: [{ path: ["id"], message: "uuid" }],
      },
    }));
    await expect(createRestBridge(options(problem.fetchFn)).call("x", {}, target("get"))).resolves.toMatchObject({
      error: { name: "ViewCallError", kind: "validation", message: "Bad input.", issues: [{ path: ["id"] }] },
    });

    const bare = fakeFetch(() => ({ status: 502, body: null }));
    await expect(createRestBridge(options(bare.fetchFn)).call("x", {}, target("get"))).resolves.toMatchObject({
      error: { kind: "internal", message: "502 " },
    });

    const down = (() => Promise.reject(new Error("offline"))) as typeof fetch;
    await expect(createRestBridge(options(down)).call("x", {}, target("get"))).resolves.toMatchObject({
      error: { kind: "unreachable", message: "offline" },
    });
  });

  it("passes questions on and resumes them at the operation's /resume path", async () => {
    const asked = {
      resultType: "input_required",
      inputRequests: { c: { method: "elicitation/create", params: { message: "Sure?", requestedSchema: {} } } },
      requestState: "sealed",
    };
    const { fetchFn, requests } = fakeFetch((url) =>
      url.endsWith("/resume") ? { body: { resultType: "complete", data: { done: true }, meta: {} } } : { body: asked },
    );
    const bridge = createRestBridge(options(fetchFn));
    await expect(bridge.call("x", { id: "1" }, target("update"))).resolves.toEqual({
      input: { requests: { c: { message: "Sure?", fields: {} } }, requestState: "sealed" },
    });
    const resume = { inputResponses: { c: { action: "accept" as const } }, requestState: "sealed" };
    await expect(bridge.call("x", { id: "1" }, target("update", { resume }))).resolves.toEqual({
      data: { done: true },
    });
    expect(requests[1]).toMatchObject({
      url: "/api/contacts/ops/update/resume",
      json: { input: { id: "1" }, ...resume },
    });
  });

  it("describes a page as fullscreen unless told otherwise", () => {
    const host = createRestBridge(options(fakeFetch(() => ({ body: {} })).fetchFn)).host();
    expect(host).toMatchObject({ displayMode: "fullscreen", platform: "web" });
    expect(["light", "dark"]).toContain(host.theme);
    const custom = createRestBridge({ ...options(fakeFetch(() => ({ body: {} })).fetchFn), host: { theme: "dark" } });
    expect(custom.host()).toEqual({ theme: "dark" });
  });
});

describe("restBoot", () => {
  it("names operations of the view's app, or of another with app.operation, for the root view's features", () => {
    expect(
      restBoot({ view: "contacts/profile", operations: ["get", "customers.lookup"], features: { actions: true } }),
    ).toEqual({
      view: "contacts/profile",
      channel: "rest",
      operations: { "contacts.get": { tool: "get" }, "customers.lookup": { tool: "lookup" } },
      features: { "contacts/profile": { actions: true } },
    });
  });

  it("takes features keyed by view as they are, and carries hostStyles", () => {
    const boot = restBoot({
      view: "contacts/profile",
      operations: [],
      features: { "contacts/profile": { actions: false }, "customers/badge": { compact: true } },
      hostStyles: "ignore",
    });
    expect(boot.features).toEqual({ "contacts/profile": { actions: false }, "customers/badge": { compact: true } });
    expect(boot.hostStyles).toBe("ignore");
  });
});

const invoices = defineApp({
  name: "invoices",
  version: "1.0.0",
  description: "Invoices.",
  operations: {
    get: op({
      description: "Fetch one invoice.",
      input: z.object({ id: z.string(), expand: z.boolean().default(false) }),
      output: z.object({ id: z.string(), totalCents: z.number() }),
      annotations: { readOnly: true },
      handler: ({ id }) => ({ id, totalCents: 1 }),
    }),
    ping: op({
      description: "Ping.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      annotations: { readOnly: true },
      handler: () => ({ ok: true }),
    }),
  },
});

describe("REST client", () => {
  const client = (handler: Handler) => {
    const { fetchFn, requests } = fakeFetch(handler);
    return {
      requests,
      api: createRestClient<typeof invoices>({
        app: "invoices",
        headers: () => ({ authorization: "Bearer t" }),
        fetch: fetchFn,
      }),
    };
  };

  it("calls an operation by name and returns its data, typed from the app", async () => {
    const { api, requests } = client(() => ({
      body: { resultType: "complete", data: { id: "inv_1", totalCents: 1200 }, meta: {} },
    }));
    const invoice = await api.get({ id: "inv_1" });
    expect(invoice).toEqual({ id: "inv_1", totalCents: 1200 });
    expect(requests[0]).toMatchObject({ url: "/api/invoices/ops/get", json: { id: "inv_1" } });
    expect(requests[0]?.init.headers).toMatchObject({ authorization: "Bearer t" });

    // Input is the schema's input type (the default makes `expand` optional); output is its output type.
    expectTypeOf(api.get).parameter(0).toEqualTypeOf<{ id: string; expand?: boolean | undefined }>();
    expectTypeOf(invoice).toEqualTypeOf<{ id: string; totalCents: number }>();
    expectTypeOf(api).toHaveProperty("ping");
    // @ts-expect-error -- the app has no such operation
    const _missing: unknown = api.missing;
  });

  it("rejects with the problem's kind, message and issues", async () => {
    const { api } = client(() => ({
      status: 404,
      body: { title: "not_found", detail: "No invoice inv_9." },
    }));
    const failure = await api.get({ id: "inv_9" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ViewCallError);
    expect(failure).toMatchObject({ kind: "not_found", message: "No invoice inv_9." });
  });

  it("rejects an operation that asks a question, and does not look like a promise", async () => {
    const { api } = client(() => ({
      body: { resultType: "input_required", inputRequests: {}, requestState: "s" },
    }));
    await expect(api.ping({})).rejects.toMatchObject({ kind: "input_required" });
    expect((api as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it("names its app in the URL, not from the definition it takes types from", () => {
    expect(invoices.name).toBe("invoices");
  });

  it("uses a custom base", async () => {
    const { fetchFn, requests } = fakeFetch(() => ({ body: { resultType: "complete", data: { ok: true }, meta: {} } }));
    await createRestClient<typeof invoices>({
      app: "invoices",
      base: "https://api.example.com/v1",
      fetch: fetchFn,
    }).ping({});
    expect(requests[0]?.url).toBe("https://api.example.com/v1/invoices/ops/ping");
  });
});
