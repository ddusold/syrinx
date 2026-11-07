import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  createRegistry,
  defineApp,
  noopLogger,
  noopTracer,
  op,
  prompt,
  resource,
  type Logger,
  type Principal,
  type Tracer,
} from "@syrinx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ASKS_META_KEY, createMcpSurface, ERROR_META_KEY, type McpOptions } from "./index.js";

const Invoice = z.object({
  id: z.string(),
  customer: z.string(),
  totalCents: z.number().int(),
  status: z.enum(["draft", "sent"]),
});
const inv1 = { id: "inv_1", customer: "Acme", totalCents: 1200, status: "draft" as const };
const store = new Map([["inv_1", inv1]]);
const Id = z.object({ id: z.string().min(1).describe("Invoice id, such as inv_1.") });

const invoices = defineApp({
  name: "invoices",
  version: "1.0.0",
  description: "Look up and send customer invoices.",
  operations: {
    get: op({
      title: "Get invoice",
      description: "Fetch one invoice by id. Use when the id is known.",
      input: Id,
      output: Invoice,
      annotations: { readOnly: true },
      mcp: { meta: { ui: { resourceUri: "ui://invoices/card" } } },
      handler: ({ id }, ctx) => {
        const found = store.get(id);
        if (!found) throw ctx.errors.notFound(`No invoice ${id}.`);
        return found;
      },
    }),
    send: op({
      description: "Email a draft invoice to its customer.",
      input: Id,
      output: z.object({ id: z.string(), sentBy: z.string() }),
      annotations: { idempotent: true, openWorld: true },
      visibility: ["model", "app", "rest"],
      permissions: ["invoices:write"],
      handler: ({ id }, ctx) => ({ id, sentBy: ctx.principal.id }),
    }),
    void: op({
      description: "Void an invoice after the user confirms.",
      input: Id,
      output: z.object({ id: z.string(), voided: z.boolean() }),
      annotations: { asks: true },
      visibility: ["model", "rest"],
      handler: async ({ id }, ctx) => ({ id, voided: await ctx.confirm(`Void invoice ${id}?`) }),
    }),
    list: op({
      description: "List every invoice id in the store.",
      input: z.object({}),
      output: z.array(z.string()),
      annotations: { readOnly: true },
      handler: () => [...store.keys()],
    }),
    summary: op({
      description: "Summarize the invoice store as plain text for the model.",
      input: z.object({}),
      output: z.object({ count: z.number() }),
      annotations: { readOnly: true },
      mcp: {
        name: "invoice_summary",
        structured: false,
        content: ({ count }) => [{ type: "text", text: `${count} invoice(s).` }],
      },
      handler: () => ({ count: store.size }),
    }),
    preview: op({
      description: "Render a draft invoice for the invoice view.",
      input: Id,
      output: z.object({ html: z.string() }),
      visibility: ["app"],
      handler: ({ id }) => ({ html: `<p>${id}</p>` }),
    }),
  },
  resources: {
    invoice: resource({
      uri: "invoice://{id}",
      description: "One invoice as JSON.",
      output: Invoice,
      read: ({ id }, ctx) => {
        const found = store.get(id);
        if (!found) throw ctx.errors.notFound(`No invoice ${id}.`);
        return found;
      },
    }),
    terms: resource({
      uri: "invoice://terms",
      description: "Payment terms printed on every invoice.",
      mimeType: "text/plain",
      output: z.string(),
      read: () => "Net 30.",
    }),
  },
  prompts: {
    chase: prompt({
      title: "Chase payment",
      description: "Draft a polite payment reminder for an invoice.",
      args: Id,
      complete: { id: (value) => [...store.keys()].filter((id) => id.startsWith(value)) },
      render: ({ id }) => `Write a short, friendly reminder that invoice ${id} is due.`,
    }),
    plan: prompt({
      description: "Plan the week's invoicing around a customer the user names.",
      asks: true,
      render: async (_args, ctx) => {
        const answer = await ctx.ask("Which customer?", z.object({ customer: z.string() }), { key: "customer" });
        return `Plan invoicing for ${answer?.customer ?? "every customer"}.`;
      },
    }),
  },
});

const traced: { name: string; parent: string | undefined }[] = [];
const tracer: Tracer = {
  startSpan: (name, attributes, parent) => {
    traced.push({ name, parent: parent?.traceparent });
    return noopTracer.startSpan(name, attributes);
  },
};

const tokens: Record<string, Principal> = { writer: { id: "writer", scopes: ["invoices:write"] } };
const surfaceOptions: McpOptions = {
  registry: createRegistry([invoices], { requestStateKey: "mcp-test-request-state-key-32-bytes!" }),
  name: "syrinx-test",
  version: "0.0.0",
  tracer,
  authenticate: (request) => tokens[request.headers.get("authorization")?.replace("Bearer ", "") ?? ""],
};
const surface = createMcpSurface(surfaceOptions);

type Era = "legacy" | "auto";
const clients: Client[] = [];

let elicitAnswer: "accept" | "decline" = "accept";
const elicited: string[] = [];

async function connect(
  era: Era = "auto",
  { path = "/mcp", token, canAnswer = true }: { path?: string; token?: string; canAnswer?: boolean } = {},
) {
  const client = new Client(
    { name: "mcp-test", version: "0.0.0" },
    { versionNegotiation: { mode: era }, capabilities: canAnswer ? { elicitation: {} } : {} },
  );
  if (canAnswer) {
    client.setRequestHandler("elicitation/create", (request) => {
      elicited.push(request.params.message);
      return elicitAnswer === "accept" && request.params.message === "Which customer?"
        ? { action: "accept", content: { customer: "Acme" } }
        : { action: elicitAnswer };
    });
  }
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost${path}`), {
    fetch: (url, init) => surface.fetch(new Request(url, init)),
    ...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  traced.length = 0;
});

describe.each<Era>(["legacy", "auto"])("MCP surface (%s negotiation)", (era) => {
  it("negotiates the expected protocol era", async () => {
    const client = await connect(era);
    expect([client.getProtocolEra(), client.getNegotiatedProtocolVersion()]).toEqual(
      era === "auto" ? ["modern", "2026-07-28"] : ["legacy", "2025-11-25"],
    );
  });

  it("lists the tools an anonymous caller may use, prefixed by app, with schemas and annotations", async () => {
    const client = await connect(era);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "invoices_get",
      "invoices_void",
      "invoices_list",
      "invoices_invoice_summary",
    ]);
    expect(tools[0]).toMatchObject({
      title: "Get invoice",
      inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"] },
      outputSchema: { type: "object", required: ["id", "customer", "totalCents", "status"] },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://invoices/card" } },
    });
    expect(tools.find((t) => t.name === "invoices_void")?._meta).toEqual({ [ASKS_META_KEY]: true });
  });

  it("lists scoped tools only to callers holding the scopes", async () => {
    const client = await connect(era, { token: "writer" });
    const send = (await client.listTools()).tools.find((t) => t.name === "invoices_send");
    expect(send?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    const result = await client.callTool({ name: "invoices_send", arguments: { id: "inv_1" } });
    expect(result.structuredContent).toEqual({ id: "inv_1", sentBy: "writer" });
  });

  it("returns structured content plus a text rendering", async () => {
    const client = await connect(era);
    const result = await client.callTool({ name: "invoices_get", arguments: { id: "inv_1" } });
    expect(result.structuredContent).toEqual(inv1);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(inv1) }]);
  });

  it("returns non-object outputs bare to modern clients; the SDK wraps them for legacy ones", async () => {
    const client = await connect(era);
    const result = await client.callTool({ name: "invoices_list", arguments: {} });
    expect(result.structuredContent).toEqual(era === "auto" ? ["inv_1"] : { result: ["inv_1"] });
  });

  it("applies per-operation overrides: name, content, and no structured output", async () => {
    const client = await connect(era);
    const tool = (await client.listTools()).tools.find((t) => t.name === "invoices_invoice_summary");
    expect(tool?.outputSchema).toBeUndefined();
    const result = await client.callTool({ name: "invoices_invoice_summary", arguments: {} });
    expect(result).toMatchObject({ content: [{ type: "text", text: "1 invoice(s)." }] });
    expect(result.structuredContent).toBeUndefined();
  });

  it("reports validation and domain failures as tool errors, not protocol errors", async () => {
    const client = await connect(era);
    const invalid = await client.callTool({ name: "invoices_get", arguments: { id: "" } });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toBeUndefined();
    expect(invalid._meta?.[ERROR_META_KEY]).toMatchObject({ kind: "validation", issues: [{ path: "id" }] });
    const missing = await client.callTool({ name: "invoices_get", arguments: { id: "inv_404" } });
    expect(missing).toMatchObject({ isError: true, content: [{ text: "not_found: No invoice inv_404." }] });
  });

  it("asks for confirmation through elicitation on modern clients, and hands legacy ones a token to confirm with", async () => {
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
      // Nothing ran: the user's confirmation is asked through the model, with a token that repeats the call.
      expect(accepted.isError).toBe(true);
      expect(accepted._meta?.[ERROR_META_KEY]).toMatchObject({ kind: "confirmation_required" });
      const text = JSON.stringify(accepted.content);
      expect(text).toContain("Void invoice inv_1?");
      const token = /confirmationToken: (\S+)/.exec(String((accepted.content as { text?: string }[])[0]?.text))?.[1];
      expect(token).toBeTruthy();
      const tool = (await client.listTools()).tools.find((t) => t.name === "invoices_void");
      expect(tool?.inputSchema.properties).toHaveProperty("confirmationToken");
      // The token belongs to these arguments: another call's is refused, and the same call goes through with it.
      const other = await client.callTool({
        name: "invoices_void",
        arguments: { id: "inv_2", confirmationToken: token },
      });
      expect(other.isError).toBe(true);
      expect(JSON.stringify(other.content)).toContain("requestState");
      const confirmed = await client.callTool({
        name: "invoices_void",
        arguments: { id: "inv_1", confirmationToken: token },
      });
      expect(confirmed.structuredContent).toEqual({ id: "inv_1", voided: true });
    }
  });

  it("serves fixed resources and templates, raw bodies for non-JSON types", async () => {
    const client = await connect(era);
    expect((await client.listResources()).resources).toMatchObject([
      { uri: "invoice://terms", name: "invoices_terms", mimeType: "text/plain" },
    ]);
    expect((await client.readResource({ uri: "invoice://terms" })).contents).toEqual([
      { uri: "invoice://terms", mimeType: "text/plain", text: "Net 30." },
    ]);
    const { contents } = await client.readResource({ uri: "invoice://inv_1" });
    expect(contents).toEqual([{ uri: "invoice://inv_1", mimeType: "application/json", text: JSON.stringify(inv1) }]);
    await expect(client.readResource({ uri: "invoice://inv_404" })).rejects.toThrow(/No invoice inv_404/);
  });

  it("lists and renders prompts with validated string arguments", async () => {
    const client = await connect(era);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["invoices_chase", "invoices_plan"]);
    expect(prompts.slice(0, 1)).toMatchObject([
      {
        name: "invoices_chase",
        title: "Chase payment",
        arguments: [{ name: "id", description: "Invoice id, such as inv_1.", required: true }],
      },
    ]);
    const rendered = await client.getPrompt({ name: "invoices_chase", arguments: { id: "inv_1" } });
    expect(rendered.messages).toEqual([
      { role: "user", content: { type: "text", text: "Write a short, friendly reminder that invoice inv_1 is due." } },
    ]);
    await expect(client.getPrompt({ name: "invoices_chase", arguments: { id: "" } })).rejects.toThrow(
      /failed validation/,
    );
  });

  it("suggests prompt arguments through completion/complete", async () => {
    const client = await connect(era);
    expect(client.getServerCapabilities()?.completions).toEqual({});
    const result = await client.complete({
      ref: { type: "ref/prompt", name: "invoices_chase" },
      argument: { name: "id", value: "inv" },
    });
    expect(result.completion).toEqual({ values: ["inv_1"], total: 1, hasMore: false });
  });

  it("asks from prompts on modern clients", async () => {
    const client = await connect(era);
    elicitAnswer = "accept";
    if (era === "auto") {
      const rendered = await client.getPrompt({ name: "invoices_plan", arguments: {} });
      expect(rendered.messages).toMatchObject([{ content: { text: "Plan invoicing for Acme." } }]);
    } else {
      await expect(client.getPrompt({ name: "invoices_plan", arguments: {} })).rejects.toThrow(/2026-07-28 client/);
    }
  });

  it("passes trace context from _meta into the span", async () => {
    const client = await connect(era);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    await client.callTool({ name: "invoices_get", arguments: { id: "inv_1" }, _meta: { traceparent } });
    expect(traced).toEqual([{ name: "operation invoices.get", parent: traceparent }]);
  });
});

describe("clients that cannot answer questions", () => {
  it("get a confirmation token for the model to relay instead of an unseen decline", async () => {
    const client = await connect("auto", { canAnswer: false });
    elicited.length = 0;
    const asked = await client.callTool({ name: "invoices_void", arguments: { id: "inv_1" } });
    expect(elicited).toEqual([]);
    expect(asked.isError).toBe(true);
    expect(asked._meta?.[ERROR_META_KEY]).toMatchObject({ kind: "confirmation_required" });
    const token = /confirmationToken: (\S+)/.exec(String((asked.content as { text?: string }[])[0]?.text))?.[1];
    expect(token).toBeTruthy();
    const confirmed = await client.callTool({
      name: "invoices_void",
      arguments: { id: "inv_1", confirmationToken: token },
    });
    expect(confirmed.structuredContent).toEqual({ id: "inv_1", voided: true });
    const planned = await client.getPrompt({ name: "invoices_plan", arguments: {} });
    expect(planned.messages).toMatchObject([{ content: { text: "Plan invoicing for every customer." } }]);
  });
});

describe("endpoints and protection", () => {
  it("serves one app unprefixed at /mcp/{app}, and 404s unknown apps", async () => {
    const client = await connect("auto", { path: "/mcp/invoices" });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["get", "void", "list", "invoice_summary"]);
    expect((await surface.fetch(new Request("http://localhost/mcp/nope", { method: "POST" }))).status).toBe(404);
  });

  it("marks list results cacheable per caller when lists depend on scopes", async () => {
    const response = await surface.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "raw", version: "0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
    );
    const body = (await response.json()) as { result?: { ttlMs?: number; cacheScope?: string } };
    expect(body.result).toMatchObject({ ttlMs: 60_000, cacheScope: "private" });
  });

  it("refuses subscription streams and advertises no list changes", async () => {
    const client = await connect("auto");
    expect(client.getServerCapabilities()).toMatchObject({
      tools: { listChanged: false },
      prompts: { listChanged: false },
      resources: { listChanged: false },
    });
    const response = await surface.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-method": "subscriptions/listen" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "subscriptions/listen", params: {} }),
      }),
    );
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({ id: 7, error: { code: -32601 } });
  });

  it("rejects foreign Host and Origin headers (DNS rebinding)", async () => {
    const post = (headers: Record<string, string>) =>
      surface.fetch(new Request("http://localhost/mcp", { method: "POST", headers, body: "{}" }));
    expect((await post({ host: "evil.example" })).status).toBe(403);
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
  });

  it("adds hosts from SYRINX_ALLOWED_HOSTS to localhost, and lets an explicit option win", async () => {
    const post = (s: typeof surface, host: string) =>
      s.fetch(new Request("http://localhost/mcp", { method: "POST", headers: { host }, body: "{}" }));
    vi.stubEnv("SYRINX_ALLOWED_HOSTS", "tunnel.example, preview.example");
    try {
      const fromEnv = createMcpSurface(surfaceOptions);
      expect((await post(fromEnv, "tunnel.example")).status).not.toBe(403);
      expect((await post(fromEnv, "preview.example")).status).not.toBe(403);
      expect((await post(fromEnv, "localhost")).status).not.toBe(403);
      expect((await post(fromEnv, "evil.example")).status).toBe(403);
      const explicit = createMcpSurface({ ...surfaceOptions, allowedHosts: ["only.example"] });
      expect((await post(explicit, "tunnel.example")).status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("challenges anonymous callers when auth is required", async () => {
    const strict = createMcpSurface({
      ...surfaceOptions,
      requireAuth: true,
      oauth: {
        oauthMetadata: {
          issuer: "https://auth.example",
          authorization_endpoint: "https://auth.example/authorize",
          token_endpoint: "https://auth.example/token",
          response_types_supported: ["code"],
        },
        resourceServerUrl: new URL("http://localhost/mcp"),
      },
    });
    const response = await strict.fetch(new Request("http://localhost/mcp", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    );
    const metadata = await strict.fetch(new Request("http://localhost/.well-known/oauth-protected-resource/mcp"));
    expect(await metadata.json()).toMatchObject({
      resource: "http://localhost/mcp",
      authorization_servers: ["https://auth.example"],
    });
  });

  it("warns about weak descriptions and rejects tool name collisions at startup", () => {
    const warnings: string[] = [];
    const logger: Logger = { ...noopLogger, warn: (m) => warnings.push(m) };
    const app = defineApp({
      name: "terse",
      version: "0.0.0",
      description: "Terse descriptions.",
      operations: {
        a: op({
          description: "Does a.",
          input: z.object({ x: z.string() }),
          output: z.null(),
          annotations: { readOnly: true },
          handler: () => null,
        }),
        b: op({
          description: "Does b, too.",
          input: z.object({}),
          output: z.null(),
          annotations: { readOnly: true },
          mcp: { name: "a" },
          handler: () => null,
        }),
      },
    });
    expect(() => createMcpSurface({ registry: createRegistry([app]), name: "t", version: "0", logger })).toThrow(
      /both project to MCP tool "terse_a"/,
    );
    expect(warnings).toEqual([]);
    const ok = defineApp({ ...app, operations: { a: app.operations.a } });
    createMcpSurface({ registry: createRegistry([ok]), name: "t", version: "0", logger });
    expect(warnings).toEqual([
      "MCP description lint: terse.a description is 7 characters; say what it does and when to use it.",
      "MCP description lint: terse.a.x input field has no description.",
    ]);
  });
});

describe("unhandled errors", () => {
  const broken = defineApp({
    name: "broken",
    version: "1.0.0",
    description: "Fails on purpose.",
    operations: {
      explode: op({
        description: "Throw a plain error, to test how the surface reports it.",
        input: z.object({}),
        output: z.object({}),
        annotations: { readOnly: true },
        handler: () => {
          throw new TypeError("boom");
        },
      }),
    },
  });
  const explode = async (logger: Logger | false | undefined) => {
    const brokenSurface = createMcpSurface({
      registry: createRegistry([broken]),
      name: "t",
      version: "0",
      ...(logger !== undefined ? { logger } : {}),
    });
    const client = new Client({ name: "mcp-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: (url, init) => brokenSurface.fetch(new Request(url, init)),
      }),
    );
    clients.push(client);
    return client.callTool({ name: "broken_explode", arguments: {} });
  };

  it("logs the cause and tool context, and tells the model only that something failed", async () => {
    const entries: unknown[] = [];
    const result = await explode({
      ...noopLogger,
      error: (message, attributes) => entries.push({ message, attributes }),
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain("boom");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      message: "unhandled error",
      attributes: {
        "syrinx.surface": "mcp",
        "syrinx.app": "broken",
        "syrinx.operation": "explode",
        "syrinx.request_id": expect.any(String) as string,
        "error.type": "TypeError",
        "error.message": "boom",
        "error.stack": expect.stringContaining("TypeError: boom") as string,
      },
    });
  });

  it("falls back to console.error without a logger, and stays quiet with logger: false", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await explode(undefined);
      expect(spy).toHaveBeenCalledWith("syrinx: unhandled error", expect.any(Object), expect.any(TypeError));
      spy.mockClear();
      await explode(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
