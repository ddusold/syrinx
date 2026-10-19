import { createRegistry } from "@syrinx/core";
import { createRestApp } from "@syrinx/rest";
import { Hono } from "hono";
import { invoices } from "./invoices.js";
import { createMcpEndpoint, type McpOptions } from "./mcp.js";

/** REST and MCP over one registry in one Hono app: the seam the spike is testing. */
export function createSpikeApp(options: Pick<McpOptions, "invokeOptions" | "toolMeta"> = {}) {
  const registry = createRegistry([invoices], { requestStateKey: "spike-only-request-state-key-32-bytes" });
  const mcp = createMcpEndpoint({ registry, name: "syrinx-spike", version: "0.0.0", ...options });
  const app = new Hono();
  app.all("/mcp", (c) => mcp.fetch(c.req.raw));
  app.route("/", createRestApp({ registry }));
  return { app, mcp };
}
