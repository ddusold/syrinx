import { checkParity, createInProcessClient, createRestClient, type Outcome, type SyrinxClient } from "@syrinx/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createInvoicesHost, demoPrincipals } from "./host.js";

let clients: { inProcess: SyrinxClient; rest: SyrinxClient };
let audit: string[];

function setup(principal: "reader" | "writer" | "anonymous") {
  audit = [];
  const host = createInvoicesHost({ audit: (r) => audit.push(`${r.operation}:${r.outcome}`) });
  const known = principal === "anonymous" ? undefined : demoPrincipals[principal];
  clients = {
    inProcess: createInProcessClient(host.registry, { deps: host.deps, ...(known ? { principal: known } : {}) }),
    rest: createRestClient({
      fetch: host.app.fetch,
      headers: principal === "anonymous" ? {} : { authorization: `Bearer ${principal}` },
    }),
  };
}

const both = () => [clients.inProcess, clients.rest];
const data = (outcome: Outcome) => (outcome.status === "complete" ? outcome.data : outcome);

describe("parity between in-process and REST", () => {
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
    ["create", { customer: "Initech", totalCents: 100 }],
  ])("%s %j", async (operation, input) => {
    const { differences } = await checkParity(both(), (c) => c.invoke("invoices", operation, input));
    expect(differences).toEqual([]);
  });

  it("reads resources the same way", async () => {
    const { outcomes, differences } = await checkParity(both(), (c) => c.read("invoices", "invoice", { id: "inv_1" }));
    expect(differences).toEqual([]);
    expect(outcomes.rest).toMatchObject({ status: "complete", data: { customer: "Acme Corp" } });
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

  it.each(["inProcess", "rest"] as const)("confirms before sending (%s)", async (surface) => {
    const client = clients[surface];
    const created = data(await client.invoke("invoices", "create", { customer: "Initech", totalCents: 4200 }));
    const { id } = created as { id: string };

    const asked = await client.invoke("invoices", "send", { id });
    if (asked.status !== "input_required") throw new Error(`expected a question, got ${asked.status}`);
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
