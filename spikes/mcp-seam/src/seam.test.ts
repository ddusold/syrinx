import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { noopTracer, type Tracer } from "@syrinx/core";
import { afterEach, describe, expect, it } from "vitest";
import { ASKS_META_KEY, ERROR_META_KEY } from "./mcp.js";
import { createSpikeApp } from "./server.js";

type Era = "legacy" | "auto";

const traced: { name: string; parent: string | undefined }[] = [];
const tracer: Tracer = {
  startSpan: (name, attributes, parent) => {
    traced.push({ name, parent: parent?.traceparent });
    return noopTracer.startSpan(name, attributes);
  },
};

const uiMeta = { ui: { resourceUri: "ui://invoices/card" } };
const { app } = createSpikeApp({
  invokeOptions: { tracer },
  toolMeta: (_app, op) => (op === "get" ? uiMeta : undefined),
});
const clients: Client[] = [];

let elicitAnswer: "accept" | "decline" = "accept";
const elicited: string[] = [];

async function connect(era: Era) {
  const client = new Client(
    { name: "spike-test", version: "0.0.0" },
    { versionNegotiation: { mode: era }, capabilities: { elicitation: {} } },
  );
  client.setRequestHandler("elicitation/create", (request) => {
    elicited.push(request.params.message);
    return { action: elicitAnswer };
  });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: async (url, init) => app.request(url, init),
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  traced.length = 0;
});

describe.each<Era>(["legacy", "auto"])("MCP over SDK v2 (%s negotiation)", (era) => {
  it("negotiates the expected protocol era", async () => {
    const client = await connect(era);
    expect([client.getProtocolEra(), client.getNegotiatedProtocolVersion()]).toEqual(
      era === "auto" ? ["modern", "2026-07-28"] : ["legacy", "2025-11-25"],
    );
  });

  it("lists model-visible operations with Syrinx's JSON Schemas and annotations", async () => {
    const client = await connect(era);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["invoices_get", "invoices_send", "invoices_void", "invoices_list"]);
    expect(tools[0]).toMatchObject({
      inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"] },
      outputSchema: { type: "object", required: ["id", "customer", "totalCents", "status"] },
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
  });

  it("keeps tool _meta (where views will bind) in tools/list", async () => {
    const client = await connect(era);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "invoices_get")?._meta).toMatchObject(uiMeta);
    expect(tools.find((t) => t.name === "invoices_get")?._meta).not.toHaveProperty([ASKS_META_KEY]);
    expect(tools.find((t) => t.name === "invoices_void")?._meta).toEqual({ [ASKS_META_KEY]: true });
  });

  it("returns structured content plus a text rendering", async () => {
    const client = await connect(era);
    const result = await client.callTool({ name: "invoices_get", arguments: { id: "inv_1" } });
    const invoice = { id: "inv_1", customer: "Acme", totalCents: 1200, status: "draft" };
    expect(result.structuredContent).toEqual(invoice);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(invoice) }]);
  });

  it("returns non-object outputs bare to modern clients; the SDK wraps them for legacy ones", async () => {
    const client = await connect(era);
    const result = await client.callTool({ name: "invoices_list", arguments: {} });
    expect(result.structuredContent).toEqual(era === "auto" ? ["inv_1"] : { result: ["inv_1"] });
    const rest = await app.request("/api/invoices/ops/list");
    expect(((await rest.json()) as { data: unknown }).data).toEqual(["inv_1"]);
  });

  it("reports validation failures from Syrinx's pipeline as tool errors, not protocol errors", async () => {
    const client = await connect(era);
    const result = await client.callTool({ name: "invoices_get", arguments: { id: "" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result._meta?.[ERROR_META_KEY]).toMatchObject({ kind: "validation", issues: [{ path: "id" }] });
  });

  it("reports domain errors as tool errors", async () => {
    const client = await connect(era);
    const result = await client.callTool({ name: "invoices_get", arguments: { id: "inv_404" } });
    expect(result).toMatchObject({ isError: true, content: [{ text: "not_found: No invoice inv_404." }] });
  });

  it("asks for confirmation through elicitation on modern clients, and explains the limit to legacy ones", async () => {
    const client = await connect(era);
    elicited.length = 0;
    elicitAnswer = "accept";
    const accepted = await client.callTool({ name: "invoices_void", arguments: { id: "inv_1" } });
    if (era === "auto") {
      expect(elicited).toEqual(["Void invoice inv_1?"]);
      expect(accepted.structuredContent).toEqual({ id: "inv_1", voided: true });
      elicitAnswer = "decline";
      const declined = await client.callTool({ name: "invoices_void", arguments: { id: "inv_1" } });
      expect(declined.structuredContent).toEqual({ id: "inv_1", voided: false });
    } else {
      expect(elicited).toEqual([]);
      expect(accepted.isError).toBe(true);
      expect(JSON.stringify(accepted.content)).toContain("needs an MCP 2026-07-28 client");
    }
  });

  it("reads resource templates", async () => {
    const client = await connect(era);
    const { contents } = await client.readResource({ uri: "invoice://inv_1" });
    const invoice = { id: "inv_1", customer: "Acme", totalCents: 1200, status: "draft" };
    expect(contents).toEqual([{ uri: "invoice://inv_1", mimeType: "application/json", text: JSON.stringify(invoice) }]);
    await expect(client.readResource({ uri: "invoice://inv_404" })).rejects.toThrow(/No invoice inv_404/);
  });

  it("passes trace context from _meta into the span", async () => {
    const client = await connect(era);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    await client.callTool({ name: "invoices_get", arguments: { id: "inv_1" }, _meta: { traceparent } });
    expect(traced).toEqual([{ name: "operation invoices.get", parent: traceparent }]);
  });
});

describe("parity with REST", () => {
  it("returns the same data and the same error kind over both surfaces", async () => {
    const client = await connect("auto");
    const rest = await app.request("/api/invoices/ops/get?id=inv_1");
    const mcp = await client.callTool({ name: "invoices_get", arguments: { id: "inv_1" } });
    expect(((await rest.json()) as { data: unknown }).data).toEqual(mcp.structuredContent);

    const restError = await app.request("/api/invoices/ops/get?id=");
    const mcpError = await client.callTool({ name: "invoices_get", arguments: { id: "" } });
    expect(((await restError.json()) as { type: string }).type).toBe(
      "https://ddusold.github.io/syrinx/problems/validation",
    );
    expect(mcpError._meta?.[ERROR_META_KEY]).toMatchObject({ kind: "validation" });
  });

  it("keeps app-only operations off both public surfaces", async () => {
    const client = await connect("auto");
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("invoices_preview");
    expect((await app.request("/api/invoices/ops/preview", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
