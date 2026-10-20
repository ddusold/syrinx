import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createRegistry, defineApp, op, view, type AuditRecord, type ViewBoot } from "@syrinx/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createMcpSurface,
  SURFACE_META_KEY,
  VIEW_CALL_TOOL,
  VIEW_META_KEY,
  VIEW_MIME_TYPE,
  type McpOptions,
  type ViewShells,
} from "./index.js";

const entry = new URL("./views/View.vue", import.meta.url);
const Customer = z.object({ name: z.string(), tier: z.string() });
const Invoice = z.object({ id: z.string(), customer: z.string() });

const customers = defineApp({
  name: "customers",
  version: "1.0.0",
  description: "Customer records.",
  operations: {
    get: op({
      description: "Fetch one customer by name.",
      input: z.object({ name: z.string() }),
      output: Customer,
      annotations: { readOnly: true },
      handler: ({ name }) => ({ name, tier: "gold" }),
    }),
  },
  views: { badge: view({ entry, calls: ["get"], csp: { connectDomains: ["https://api.example.com"] } }) },
});

const invoices = defineApp({
  name: "invoices",
  version: "1.0.0",
  description: "Customer invoices.",
  operations: {
    list: op({
      description: "List every invoice.",
      input: z.object({}),
      output: z.object({ items: z.array(Invoice) }),
      annotations: { readOnly: true },
      handler: () => ({ items: [{ id: "inv_1", customer: "Acme" }] }),
    }),
    get: op({
      description: "Fetch one invoice by id.",
      input: z.object({ id: z.string() }),
      output: Invoice,
      annotations: { readOnly: true },
      handler: ({ id }) => ({ id, customer: "Acme" }),
    }),
    send: op({
      description: "Email a draft invoice to its customer.",
      input: z.object({ id: z.string() }),
      output: Invoice,
      visibility: ["model", "app"],
      handler: ({ id }) => ({ id, customer: "Acme" }),
    }),
    select: op({
      description: "Remember which invoice the user is looking at.",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      visibility: ["app"],
      handler: (input) => input,
    }),
    void: op({
      description: "Void an invoice after the user confirms.",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), voided: z.boolean() }),
      visibility: ["model", "app"],
      confirm: ({ id }) => `Void invoice ${id}?`,
      handler: ({ id }) => ({ id, voided: true }),
    }),
    purge: op({
      description: "Delete every invoice in the store.",
      input: z.object({}),
      output: z.object({}),
      visibility: ["model"],
      handler: () => ({}),
    }),
  },
  views: {
    browser: view({
      title: "Invoice browser",
      entry,
      boundTo: ["list", { op: "get", component: "detail" }],
      calls: ["send", "select"],
      embeds: [customers.views.badge],
      features: { actions: true },
      prefersBorder: true,
    }),
  },
});

const rendered: { view: string; boot: ViewBoot }[] = [];
const shells: ViewShells = {
  render: (v, boot) => {
    rendered.push({ view: `${v.app}/${v.name}`, boot });
    return { html: `<!doctype html><title>${v.name}</title>`, csp: { resourceDomains: ["https://cdn.example.com"] } };
  },
};

const audit: AuditRecord[] = [];
const options: McpOptions = {
  registry: createRegistry([customers, invoices], {
    audit: (r) => void audit.push(r),
    requestStateKey: "views-test-request-state-key-32-bytes!",
  }),
  name: "views-test",
  version: "0.0.0",
  views: shells,
};
const surface = createMcpSurface(options);
const { views: _views, ...withoutViews } = options;
const bare = createMcpSurface(withoutViews);

const clients: Client[] = [];
async function connect(
  path = "/mcp",
  target = surface,
  { era = "legacy", apps = false }: { era?: "legacy" | "auto"; apps?: boolean } = {},
) {
  // No elicitation capability: like a host that will not show questions outside a chat turn. `apps` declares MCP
  // Apps support, as hosts that render views do.
  const capabilities = apps ? { extensions: { "io.modelcontextprotocol/ui": {} } } : {};
  const client = new Client(
    { name: "views-test", version: "0.0.0" },
    { versionNegotiation: { mode: era }, capabilities: capabilities },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://localhost${path}`), {
      fetch: (url, init) => target.fetch(new Request(url, init)),
    }),
  );
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  rendered.length = 0;
  audit.length = 0;
});

describe("views over MCP", () => {
  it("points bound tools at their ui:// resource and marks who may call each tool", async () => {
    const { tools } = await (await connect("/mcp/invoices")).listTools();
    const ui = Object.fromEntries(tools.map((t) => [t.name, t._meta?.ui]));
    expect(ui).toEqual({
      list: { resourceUri: "ui://invoices/browser" },
      get: { resourceUri: "ui://invoices/browser" },
      send: undefined,
      select: { visibility: ["app"] },
      void: undefined,
      purge: { visibility: ["model"] },
      [VIEW_CALL_TOOL]: { visibility: ["app"] },
    });
  });

  it("lists view resources as MCP Apps HTML and reads the rendered shell with merged CSP", async () => {
    const client = await connect("/mcp/invoices");
    const listed = (await client.listResources()).resources.find((r) => r.uri === "ui://invoices/browser");
    expect(listed).toMatchObject({ mimeType: VIEW_MIME_TYPE, title: "Invoice browser" });

    const read = await client.readResource({ uri: "ui://invoices/browser" });
    expect(read.contents[0]).toMatchObject({
      uri: "ui://invoices/browser",
      mimeType: VIEW_MIME_TYPE,
      text: "<!doctype html><title>browser</title>",
      _meta: { ui: { csp: { resourceDomains: ["https://cdn.example.com"] }, prefersBorder: true } },
    });
  });

  it("boots views with tool names for the endpoint, leaving out apps it does not serve", async () => {
    await (await connect("/mcp/invoices")).readResource({ uri: "ui://invoices/browser" });
    await (await connect("/mcp")).readResource({ uri: "ui://invoices/browser" });
    const [single, all] = rendered.map((r) => r.boot);

    expect(single?.operations).toEqual({
      "invoices.send": { tool: "send" },
      "invoices.select": { tool: "select" },
      "invoices.list": { tool: "list", schemaVersion: expect.any(String) as string },
      "invoices.get": { tool: "get", schemaVersion: expect.any(String) as string },
    });
    expect(single).toMatchObject({
      view: "invoices/browser",
      channel: "mcp",
      features: { "invoices/browser": { actions: true }, "customers/badge": {} },
    });
    expect(all?.operations["customers.get"]).toEqual({ tool: "customers_get" });
    expect(all?.operations["invoices.send"]).toEqual({ tool: "invoices_send" });
  });

  it("carries the view, op, component and schema version on bound results", async () => {
    const client = await connect("/mcp/invoices");
    const listed = await client.callTool({ name: "list", arguments: {} });
    const got = await client.callTool({ name: "get", arguments: { id: "inv_1" } });
    const sent = await client.callTool({ name: "send", arguments: { id: "inv_1" } });
    expect(listed._meta?.[VIEW_META_KEY]).toMatchObject({ view: "invoices/browser", op: "list" });
    expect(got._meta?.[VIEW_META_KEY]).toMatchObject({ view: "invoices/browser", op: "get", component: "detail" });
    expect(got.structuredContent).toEqual({ id: "inv_1", customer: "Acme" });
    expect(sent._meta?.[VIEW_META_KEY]).toBeUndefined();
    const boot = (await client.readResource({ uri: "ui://invoices/browser" }), rendered[0]?.boot);
    expect((listed._meta?.[VIEW_META_KEY] as { schemaVersion: string }).schemaVersion).toBe(
      boot?.operations["invoices.list"]?.schemaVersion,
    );
  });

  it("audits calls a view marks, and calls to view-only operations, as the app surface", async () => {
    const client = await connect("/mcp/invoices");
    await client.callTool({ name: "send", arguments: { id: "inv_1" } });
    await client.callTool({ name: "send", arguments: { id: "inv_1" }, _meta: { [SURFACE_META_KEY]: "app" } });
    await client.callTool({ name: "select", arguments: { id: "inv_1" } });
    expect(audit.map((r) => `${r.operation}:${r.surface}`)).toEqual(["send:model", "send:app", "select:app"]);
  });

  it("gzips large responses for clients that accept it, and only those", async () => {
    const seen: { method: string; encoding: string | null; bytes: number }[] = [];
    const gzipClient = async (target: typeof surface, acceptGzip: boolean) => {
      // 2026-07-28 clients get JSON responses; the 2025-era fallback answers over SSE, which is left uncompressed.
      const client = new Client({ name: "gzip-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://localhost/mcp/invoices"), {
          fetch: async (url, init) => {
            const request = new Request(url, init);
            if (acceptGzip) request.headers.set("accept-encoding", "gzip, br");
            const method = ((await request.clone().json()) as { method: string }).method;
            const response = await target.fetch(request);
            const encoding = response.headers.get("content-encoding");
            const raw = new Uint8Array(await response.arrayBuffer());
            seen.push({ method, encoding, bytes: raw.byteLength });
            // A real fetch decodes for us; this one hands the client what it would see after decoding.
            const body =
              encoding === "gzip" ? new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip")) : raw;
            const headers = new Headers(response.headers);
            headers.delete("content-encoding");
            return new Response(body, { status: response.status, headers });
          },
        }),
      );
      clients.push(client);
      return client;
    };

    const big = "x".repeat(20_000);
    const largeShells: ViewShells = { render: () => ({ html: `<!doctype html><p>${big}</p>` }) };
    const large = createMcpSurface({ ...options, views: largeShells });
    const read = await (await gzipClient(large, true)).readResource({ uri: "ui://invoices/browser" });
    expect((read.contents[0] as { text: string }).text).toContain(big);
    const shell = seen.find((s) => s.method === "resources/read");
    expect(shell?.encoding).toBe("gzip");
    expect(shell?.bytes).toBeLessThan(2_000);
    const small = seen.filter((s) => s.method !== "resources/read" && s.bytes > 0);
    expect(small.length).toBeGreaterThan(0);
    expect(small.every((s) => s.encoding === null && s.bytes < 1024)).toBe(true);

    seen.length = 0;
    await (await gzipClient(large, false)).readResource({ uri: "ui://invoices/browser" });
    await (
      await gzipClient(createMcpSurface({ ...options, views: largeShells, compress: false }), true)
    ).readResource({
      uri: "ui://invoices/browser",
    });
    expect(seen.filter((s) => s.method === "resources/read").map((s) => s.encoding)).toEqual([null, null]);
  });

  describe("the view channel", () => {
    interface Envelope {
      resultType: string;
      data?: unknown;
      view?: { view: string; op: string };
      inputRequests?: Record<string, { method: string; params: { message: string } }>;
      requestState?: string;
      error?: { kind: string; message: string };
    }
    const viewCall = async (client: Client, args: Record<string, unknown>) => {
      const result = await client.callTool({ name: VIEW_CALL_TOOL, arguments: args });
      return { isError: result.isError === true, ...(result.structuredContent as Envelope) };
    };
    const appsClient = () => connect("/mcp/invoices", surface, { era: "auto", apps: true });

    it("returns questions to the view as data and finishes on the answer it sends back", async () => {
      const client = await appsClient();
      const asked = await viewCall(client, { app: "invoices", operation: "void", input: { id: "inv_1" } });
      expect(asked).toMatchObject({ isError: false, resultType: "input_required" });
      const [key, request] = Object.entries(asked.inputRequests ?? {})[0] ?? [];
      expect(request).toMatchObject({ method: "elicitation/create", params: { message: "Void invoice inv_1?" } });

      const done = await viewCall(client, {
        app: "invoices",
        operation: "void",
        input: { id: "inv_1" },
        resume: {
          requestState: asked.requestState,
          inputResponses: { [key ?? ""]: { action: "accept", content: {} } },
        },
      });
      expect(done).toEqual({ isError: false, resultType: "complete", data: { id: "inv_1", voided: true } });
      expect(audit.filter((r) => r.operation === "void").map((r) => `${r.surface}:${r.outcome}`)).toEqual([
        "app:input_required",
        "app:complete",
      ]);
    });

    it("cancels on decline and refuses answers bound to other input", async () => {
      const client = await appsClient();
      const asked = await viewCall(client, { app: "invoices", operation: "void", input: { id: "inv_1" } });
      const key = Object.keys(asked.inputRequests ?? {})[0] ?? "";
      const answer = (action: string, id = "inv_1") =>
        viewCall(client, {
          app: "invoices",
          operation: "void",
          input: { id },
          resume: { requestState: asked.requestState, inputResponses: { [key]: { action } } },
        });
      expect(await answer("decline")).toMatchObject({ isError: true, error: { kind: "cancelled" } });
      expect(await answer("accept", "inv_2")).toMatchObject({ isError: true, resultType: "error" });
    });

    it("carries view metadata for bound operations and keeps scope and visibility", async () => {
      const client = await appsClient();
      expect(await viewCall(client, { app: "invoices", operation: "list" })).toMatchObject({
        resultType: "complete",
        view: { view: "invoices/browser", op: "list" },
      });
      // customers is not served on /mcp/invoices, and purge is not visible to views.
      expect(await viewCall(client, { app: "customers", operation: "get", input: { name: "Acme" } })).toMatchObject({
        error: { kind: "not_found" },
      });
      expect(await viewCall(client, { app: "invoices", operation: "purge" })).toMatchObject({
        error: { kind: "not_found" },
      });
    });

    it("refuses clients that do not declare MCP Apps, so a model cannot answer for the user", async () => {
      for (const client of [
        await connect("/mcp/invoices", surface, { era: "auto" }),
        await connect("/mcp/invoices", surface, { era: "legacy", apps: true }),
      ]) {
        expect(await viewCall(client, { app: "invoices", operation: "void", input: { id: "inv_1" } })).toMatchObject({
          isError: true,
          error: { kind: "unavailable" },
        });
      }
      expect(audit).toEqual([]);
    });

    it("boots views with the channel's name", async () => {
      await (await appsClient()).readResource({ uri: "ui://invoices/browser" });
      expect(rendered[0]?.boot.viewCallTool).toBe(VIEW_CALL_TOOL);
    });
  });

  it("serves no views, and hides view-only tools, without shells", async () => {
    const client = await connect("/mcp/invoices", bare);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list", "get", "send", "void", "purge"]);
    expect(tools.every((t) => t._meta?.ui === undefined)).toBe(true);
    expect((await client.listResources()).resources).toEqual([]);
  });
});
