import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serveRegistryStdio } from "@syrinx/mcp/stdio";
import { loadViewShells } from "@syrinx/ui/server";
import { createInvoicesHost } from "./host.js";

// For local MCP clients such as VS Code. stdout carries the protocol, so everything else goes to stderr.
function openLogFile(path: string | undefined) {
  if (!path) return undefined;
  try {
    // The default path is under dist/, which exists only after a views build.
    mkdirSync(dirname(path), { recursive: true });
    const stream = createWriteStream(path, { flags: "a" });
    // Logging must never take the server down: a failing log file just stops receiving lines.
    stream.on("error", (error) => {
      console.error(`Cannot write ${path}: ${String(error)}`);
    });
    return stream;
  } catch (error) {
    console.error(`Cannot open ${path}: ${String(error)}`);
    return undefined;
  }
}
const logFile = openLogFile(process.env.SYRINX_LOG_FILE);
function log(level: string, message: string, attributes?: Record<string, unknown>) {
  const line = `${new Date().toISOString()} ${level} ${message}${attributes ? ` ${JSON.stringify(attributes)}` : ""}`;
  if (logFile?.writable) logFile.write(`${line}\n`);
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
