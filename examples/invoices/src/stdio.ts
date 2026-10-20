import { appendFileSync, existsSync } from "node:fs";
import { serveRegistryStdio } from "@syrinx/mcp/stdio";
import { loadViewShells } from "@syrinx/ui/server";
import { createInvoicesHost } from "./host.js";

// For local MCP clients such as VS Code. stdout carries the protocol, so everything else goes to stderr.
const logFile = process.env.SYRINX_LOG_FILE;
function log(level: string, message: string, attributes?: Record<string, unknown>) {
  const line = `${new Date().toISOString()} ${level} ${message}${attributes ? ` ${JSON.stringify(attributes)}` : ""}`;
  if (logFile) appendFileSync(logFile, `${line}\n`);
  if (level !== "debug") console.error(line);
}

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
  // SYRINX_LOG_FILE gets every line, debug included, for hosts that hide a server's stderr.
  logger: {
    debug: (m, a) => {
      log("debug", m, a);
    },
    info: (m, a) => {
      log("info", m, a);
    },
    warn: (m, a) => {
      log("warn", m, a);
    },
    error: (m, a) => {
      log("error", m, a);
    },
  },
});
