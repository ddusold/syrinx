// A minimal MCP Apps host for end-to-end tests: a real MCP client talks to the example server, and the ext-apps
// AppBridge relays between it and the view in a sandboxed iframe, as Claude or VS Code would.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

declare global {
  interface Window {
    host: { ready: boolean; elicited: string[]; links: string[]; error?: string };
  }
}

const params = new URLSearchParams(location.search);
const endpoint = params.get("endpoint") ?? "/mcp/invoices";
const tool = params.get("tool") ?? "list";
const args = JSON.parse(params.get("args") ?? "{}") as Record<string, unknown>;
const theme = params.get("theme") === "dark" ? "dark" : "light";
const status = document.querySelector<HTMLElement>("#status") ?? document.body;
window.host = { ready: false, elicited: [], links: [] };

async function main() {
  const client = new Client(
    { name: "e2e-host", version: "0.0.0" },
    { versionNegotiation: { mode: "auto" }, capabilities: { elicitation: {} } },
  );
  // Like VS Code: questions are only shown during a chat turn, and a click in a view is never one, so decline.
  client.setRequestHandler("elicitation/create", (request) => {
    window.host.elicited.push(request.params.message);
    return { action: "decline" };
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint, location.href), {
      requestInit: { headers: { authorization: "Bearer writer" } },
    }),
  );

  const { tools } = await client.listTools();
  const uri = (tools.find((t) => t.name === tool)?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri;
  if (!uri) throw new Error(`Tool ${tool} has no view.`);
  const result = await client.callTool({ name: tool, arguments: args });
  const resource = await client.readResource({ uri });
  const html = (resource.contents[0] as { text: string }).text;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.title = "view";
  document.getElementById("frame")?.append(iframe);
  iframe.srcdoc = html;

  const bridge = new AppBridge(
    client,
    { name: "e2e-host", version: "0.0.0" },
    { openLinks: {}, serverTools: {}, serverResources: {} },
    { hostContext: { theme, displayMode: "inline", locale: "en-US", platform: "web" } },
  );
  bridge.addEventListener("initialized", () => {
    void bridge.sendToolResult(result);
    window.host.ready = true;
    status.textContent = "ready";
  });
  bridge.addEventListener("sizechange", ({ height }) => {
    if (height) iframe.style.height = `${Math.ceil(height)}px`;
  });
  bridge.onopenlink = ({ url }) => {
    window.host.links.push(url);
    return Promise.resolve({});
  };
  const target = iframe.contentWindow;
  if (!target) throw new Error("The view iframe has no window.");
  await bridge.connect(new PostMessageTransport(target, target));
}

main().catch((error: unknown) => {
  window.host.error = error instanceof Error ? error.message : String(error);
  status.textContent = `error: ${window.host.error}`;
});
