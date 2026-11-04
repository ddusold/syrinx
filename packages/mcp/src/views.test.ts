import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createRegistry, defineApp, op, prompt, view, type AuditRecord, type ViewBoot } from "@syrinx/core";
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
      description: "Browse and open the organization's invoices, and send a draft to its customer.",
      entry,
      boundTo: ["list", { op: "get", component: "detail" }],
      calls: ["send", "select", "void"],
      embeds: [customers.views.badge],
      features: { actions: true },
      hostStyles: "ignore",
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

describe("server instructions", () => {
  it("sends what the model should know about the server when it connects: fixed text, or made for the caller", async () => {
    const withInstructions = (instructions: McpOptions["instructions"]) =>
      createMcpSurface({ ...options, ...(instructions ? { instructions } : {}) });

    expect((await connect("/mcp", withInstructions("Invoices are in cents."))).getInstructions()).toBe(
      "Invoices are in cents.",
    );
    const made = withInstructions((caller) => `For ${caller.principal?.id ?? "nobody"}.`);
    expect((await connect("/mcp", made)).getInstructions()).toBe("For nobody.");
    expect((await connect("/mcp", surface)).getInstructions()).toBeUndefined();
  });
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

  it("tells the model what page a tool opens by adding the view's description to the tools that open it, and only those", async () => {
    const { tools } = await (await connect("/mcp/invoices")).listTools();
    const describedAs = (name: string) => tools.find((t) => t.name === name)?.description ?? "";
    for (const name of ["list", "get"]) {
      expect(describedAs(name)).toContain(
        'Opens the "Invoice browser" page. Browse and open the organization\'s invoices',
      );
    }
    // The operation's own description still leads, and tools that do not open the view are left alone.
    expect(describedAs("list")).toMatch(/^List every invoice\./);
    expect(describedAs("send")).toBe("Email a draft invoice to its customer.");
    expect(describedAs("select")).not.toContain("Opens the");
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
      "invoices.void": { tool: "void" },
      "invoices.list": { tool: "list", schemaVersion: expect.any(String) as string },
      "invoices.get": { tool: "get", schemaVersion: expect.any(String) as string },
    });
    expect(single).toMatchObject({
      view: "invoices/browser",
      channel: "mcp",
      hostStyles: "ignore",
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

  it("compresses a view shell answered over SSE, the answer every Streamable HTTP client gets, and nothing else over SSE", async () => {
    const big = "y".repeat(20_000);
    const large = createMcpSurface({ ...options, views: { render: () => ({ html: `<!doctype html><p>${big}</p>` }) } });
    const post = (body: unknown) =>
      large.fetch(
        new Request("http://localhost/mcp/invoices", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // A client that does not know the 2026 protocol accepts both, and is answered over SSE.
            accept: "application/json, text/event-stream",
            "accept-encoding": "gzip",
            "mcp-protocol-version": "2025-06-18",
          },
          body: JSON.stringify(body),
        }),
      );

    const shell = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "ui://invoices/browser" },
    });
    expect(shell.headers.get("content-type")).toContain("text/event-stream");
    expect(shell.headers.get("content-encoding")).toBe("gzip");
    const raw = new Uint8Array(await shell.arrayBuffer());
    expect(raw.byteLength).toBeLessThan(2_000);
    const text = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(text).toContain(big);

    // Other SSE answers can carry notifications as they go, so they stay as they are.
    const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(tools.headers.get("content-type")).toContain("text/event-stream");
    expect(tools.headers.get("content-encoding")).toBeNull();
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
    /** Opens the browser view as a host would, and returns the token its shell carries. */
    const tokenFor = async (client: Client) => {
      await client.readResource({ uri: "ui://invoices/browser" });
      return rendered.at(-1)?.boot.viewToken ?? "";
    };
    const appsClient = async (era: "legacy" | "auto" = "auto") => {
      const client = await connect("/mcp/invoices", surface, { era, apps: true });
      return { client, token: await tokenFor(client) };
    };

    it("returns questions to the view as data and finishes on the answer it sends back", async () => {
      const { client, token } = await appsClient();
      const call = { app: "invoices", operation: "void", input: { id: "inv_1" }, token };
      const asked = await viewCall(client, call);
      expect(asked).toMatchObject({ isError: false, resultType: "input_required" });
      const [key, request] = Object.entries(asked.inputRequests ?? {})[0] ?? [];
      expect(request).toMatchObject({ method: "elicitation/create", params: { message: "Void invoice inv_1?" } });

      const done = await viewCall(client, {
        ...call,
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

    it("cancels on decline, refuses answers bound to other input, and requires the state answers belong to", async () => {
      const { client, token } = await appsClient();
      const asked = await viewCall(client, { app: "invoices", operation: "void", input: { id: "inv_1" }, token });
      const key = Object.keys(asked.inputRequests ?? {})[0] ?? "";
      const answer = (action: string, id = "inv_1", state: { requestState?: string } = asked) =>
        viewCall(client, {
          app: "invoices",
          operation: "void",
          input: { id },
          token,
          resume: { requestState: state.requestState, inputResponses: { [key]: { action } } },
        });
      expect(await answer("decline")).toMatchObject({ isError: true, error: { kind: "cancelled" } });
      expect(await answer("accept", "inv_2")).toMatchObject({ isError: true, resultType: "error" });
      expect(await answer("accept", "inv_1", {})).toMatchObject({ error: { kind: "validation" } });
    });

    it("serves 2025-era hosts over stateless HTTP, whose declarations are not kept, on the token alone", async () => {
      const { client, token } = await appsClient("legacy");
      expect(
        await viewCall(client, { app: "invoices", operation: "void", input: { id: "inv_1" }, token }),
      ).toMatchObject({ resultType: "input_required" });
    });

    it("carries view metadata for bound operations, and only reaches what the token's view reaches", async () => {
      const { client, token } = await appsClient();
      expect(await viewCall(client, { app: "invoices", operation: "list", token })).toMatchObject({
        resultType: "complete",
        view: { view: "invoices/browser", op: "list" },
      });
      // customers is not served on /mcp/invoices, and purge is not visible to views.
      for (const [app, operation] of [
        ["customers", "get"],
        ["invoices", "purge"],
      ]) {
        expect(await viewCall(client, { app, operation, input: {}, token })).toMatchObject({
          error: { kind: "not_found" },
        });
      }
    });

    it("refuses calls without a valid token, or from clients that declare no MCP Apps support", async () => {
      const { token } = await appsClient();
      const model = await connect("/mcp/invoices", surface, { era: "auto" });
      const apps = await connect("/mcp/invoices", surface, { era: "auto", apps: true });
      const forged = `${token.slice(0, -4)}AAAA`;
      for (const [client, args] of [
        [model, { token }],
        [apps, {}],
        [apps, { token: forged }],
      ] as const) {
        const call = { app: "invoices", operation: "void", input: { id: "inv_1" }, ...args };
        expect(await viewCall(client, call)).toMatchObject({ isError: true, error: { kind: "unavailable" } });
      }
      expect(audit).toEqual([]);
    });

    it("boots views with the channel's name and a token, and hints as cautiously as its riskiest operation", async () => {
      const { client, token } = await appsClient();
      expect(rendered[0]?.boot.viewCallTool).toBe(VIEW_CALL_TOOL);
      expect(token).not.toBe("");
      const tool = (await client.listTools()).tools.find((t) => t.name === VIEW_CALL_TOOL);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    });

    it("rejects an operation named like the channel at startup", () => {
      const clash = defineApp({
        name: "clash",
        version: "1.0.0",
        description: "Clashes with the view channel.",
        operations: {
          call: op({
            description: "Named like the view channel.",
            input: z.object({}),
            output: z.object({}),
            annotations: { readOnly: true },
            mcp: { name: VIEW_CALL_TOOL },
            handler: () => ({}),
          }),
        },
      });
      expect(() => createMcpSurface({ ...options, registry: createRegistry([clash]) })).toThrow(/view channel/);
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

describe("MCP startup and routing", () => {
  it("rejects two prompts projecting to one name", () => {
    const notes = defineApp({
      name: "notes",
      version: "1.0.0",
      description: "Notes.",
      operations: {},
      prompts: {
        recap: prompt({ description: "Recap the notes.", render: () => "Recap." }),
        summary: prompt({ description: "Summarize the notes.", mcp: { name: "recap" }, render: () => "Sum." }),
      },
    });
    expect(() => createMcpSurface({ ...options, registry: createRegistry([notes]) })).toThrow(
      /MCP prompt "notes_recap"/,
    );
  });

  it("answers 404 for a malformed app path", async () => {
    const response = await surface.fetch(new Request("http://localhost/mcp/%E0%A4", { method: "POST", body: "{}" }));
    expect(response.status).toBe(404);
  });
});
