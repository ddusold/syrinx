// Serves the conformance fixtures at http://localhost:$PORT/mcp/conformance for the official suite.
import { serve } from "@hono/node-server";
import { createRegistry } from "@syrinx/core";
import { createMcpSurface } from "@syrinx/mcp";
import { conformance } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
const mcp = createMcpSurface({
  registry: createRegistry([conformance], { requestStateKey: "conformance-only-request-state-key-32b" }),
  name: "syrinx-conformance",
  version: conformance.version,
});

serve({ fetch: (request) => mcp.fetch(request), hostname: "127.0.0.1", port }, () => {
  console.log(`Conformance fixtures on http://localhost:${port}/mcp/conformance`);
});
