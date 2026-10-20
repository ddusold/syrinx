import {
  checkParity,
  createInProcessClient,
  createMcpClient,
  createRestClient,
  type Outcome,
  type SyrinxClient,
} from "@syrinx/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInvoicesHost, demoPrincipals } from "./host.js";

let clients: { inProcess: SyrinxClient; rest: SyrinxClient; mcp: ReturnType<typeof createMcpClient> };
let audit: string[];

function setup(principal: "reader" | "writer" | "anonymous") {
  audit = [];
  const host = createInvoicesHost({ audit: (r) => audit.push(`${r.operation}:${r.outcome}`) });
  const known = principal === "anonymous" ? undefined : demoPrincipals[principal];
  const headers: Record<string, string> = principal === "anonymous" ? {} : { authorization: `Bearer ${principal}` };
  clients = {
    inProcess: createInProcessClient(host.registry, { deps: host.deps, ...(known ? { principal: known } : {}) }),
    rest: createRestClient({ fetch: host.app.fetch, headers }),
    mcp: createMcpClient({ fetch: host.app.fetch, headers }),
  };
}

afterEach(async () => {
  await clients.mcp.close();
});

const every = () => [clients.inProcess, clients.rest, clients.mcp];
const data = (outcome: Outcome) => (outcome.status === "complete" ? outcome.data : outcome);

describe("parity between in-process, REST and MCP", () => {
  beforeEach(() => {
    setup("reader");
  });

  it.each([
    ["get", { id: "inv_1" }],
    ["get", { id: "nope" }],
    ["get", { id: "" }],
    ["list", {}],
    ["list", { status: "sent" }],
    ["list", { limit: 500 }],
  ])("%s %j", async (operation, input) => {
    const { differences } = await checkParity(every(), (c) => c.invoke("invoices", operation, input));
    expect(differences).toEqual([]);
  });

  it("reads resources the same way", async () => {
    const { outcomes, differences } = await checkParity(every(), (c) => c.read("invoices", "invoice", { id: "inv_1" }));
    expect(differences).toEqual([]);
    expect(outcomes.rest).toMatchObject({ status: "complete", data: { customer: "Acme Corp" } });
  });
});

describe("prompts", () => {
  beforeEach(() => {
    setup("reader");
  });

  it.each([{ id: "inv_1" }, { id: "" }, { id: "nope" }])("render the same on every surface %j", async (args) => {
    const { outcomes, differences } = await checkParity(every(), (c) => c.render("invoices", "chase", args));
    expect(differences).toEqual([]);
    if (args.id === "inv_1") {
      expect(outcomes.mcp).toMatchObject({ status: "complete", data: { messages: [{ role: "user" }] } });
      expect(JSON.stringify(outcomes.mcp)).toContain("Acme Corp");
    }
  });
});

describe("completion", () => {
  it("suggests draft invoice ids for the chase prompt", async () => {
    setup("reader");
    const host = createInvoicesHost();
    const res = await host.app.request("/api/invoices/complete", {
      method: "POST",
      headers: { authorization: "Bearer reader", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "chase", argument: "id", value: "inv" }),
    });
    expect(await res.json()).toMatchObject({ data: { values: ["inv_1"], total: 1, hasMore: false } });
  });
});

describe("MCP listing", () => {
  it("hides tools a caller lacks scopes for, where REST answers forbidden", async () => {
    setup("reader");
    expect(await clients.mcp.invoke("invoices", "create", { customer: "X", totalCents: 1 })).toMatchObject({
      kind: "not_found",
    });
    expect(await clients.rest.invoke("invoices", "create", { customer: "X", totalCents: 1 })).toMatchObject({
      kind: "forbidden",
    });
  });
});

describe("permissions", () => {
  it("asks anonymous callers to authenticate and forbids readers from writing", async () => {
    setup("anonymous");
    expect(await clients.rest.invoke("invoices", "get", { id: "inv_1" })).toMatchObject({ kind: "unauthenticated" });
    setup("reader");
    expect(await clients.rest.invoke("invoices", "create", { customer: "X", totalCents: 1 })).toMatchObject({
      kind: "forbidden",
    });
  });
});

describe("sending an invoice", () => {
  beforeEach(() => {
    setup("writer");
  });

  it.each(["inProcess", "rest", "mcp"] as const)("confirms before sending (%s)", async (surface) => {
    const client = clients[surface];
    const created = data(await client.invoke("invoices", "create", { customer: "Initech", totalCents: 4200 }));
    const { id } = created as { id: string };

    const asked = await client.invoke("invoices", "send", { id });
    if (asked.status !== "input_required") throw new Error(`expected a question, got ${JSON.stringify(asked)}`);
    expect(Object.values(asked.inputRequests)).toEqual([
      { kind: "confirm", message: `Send invoice ${id} for $42.00 to Initech?` },
    ]);

    const sent = await client.invoke(
      "invoices",
      "send",
      { id },
      { resume: { requestState: asked.requestState, inputResponses: { "input-0": { action: "accept" } } } },
    );
    expect(data(sent)).toMatchObject({ id, status: "sent" });
    expect(await client.invoke("invoices", "send", { id })).toMatchObject({ kind: "conflict" });
    expect(audit).toEqual(["create:complete", "send:input_required", "send:complete", "send:conflict"]);
  });

  it("does not send when the user declines", async () => {
    const asked = await clients.rest.invoke("invoices", "send", { id: "inv_1" });
    if (asked.status !== "input_required") throw new Error("expected a question");
    const declined = await clients.rest.invoke(
      "invoices",
      "send",
      { id: "inv_1" },
      { resume: { requestState: asked.requestState, inputResponses: { "input-0": { action: "decline" } } } },
    );
    expect(declined).toMatchObject({ status: "error", kind: "cancelled" });
    expect(data(await clients.rest.invoke("invoices", "get", { id: "inv_1" }))).toMatchObject({ status: "draft" });
  });

  it("creates once per Idempotency-Key", async () => {
    const input = { customer: "Globex", totalCents: 999 };
    const first = await clients.rest.invoke("invoices", "create", input, { idempotencyKey: "create-1" });
    const again = await clients.rest.invoke("invoices", "create", input, { idempotencyKey: "create-1" });
    expect(again).toEqual({ ...first, replayed: true });
  });
});
