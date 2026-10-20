// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createRestBridge, restBoot } from "./rest.js";

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
