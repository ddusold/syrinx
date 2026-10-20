import { existsSync } from "node:fs";
import { serveRegistryStdio } from "@syrinx/mcp/stdio";
import { loadViewShells } from "@syrinx/ui/server";
import { createInvoicesHost } from "./host.js";

// For local MCP clients such as VS Code. stdout carries the protocol, so everything else goes to stderr.
const viewsDir = new URL("../dist/views/", import.meta.url);
const views = existsSync(new URL("manifest.json", viewsDir)) ? await loadViewShells({ dir: viewsDir }) : undefined;
const { registry, deps } = createInvoicesHost(views ? { views } : {});

serveRegistryStdio({
  registry,
  deps,
  name: "invoices-example",
  version: "1.0.0",
  // stdio has no credentials; the local user may read and send.
  principal: { id: "local", scopes: ["invoices:read", "invoices:write"] },
  ...(views ? { views } : {}),
  logger: {
    debug: () => undefined,
    info: (m) => {
      console.error(m);
    },
    warn: (m) => {
      console.error(m);
    },
    error: (m) => {
      console.error(m);
    },
  },
});
