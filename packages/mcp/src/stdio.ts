import { lintApp, type Principal, type Tenant } from "@syrinx/core";
import type { Transport } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { buildServer, checkMembers, type Caller, type ProjectionOptions, type Scope } from "./projection.js";

export interface StdioOptions<Deps = unknown> extends ProjectionOptions<Deps> {
  /** Serve one app with unprefixed names instead of every app. */
  app?: string;
  /** The local user. stdio has no credentials, so the host decides who that is; anonymous by default. */
  principal?: Principal;
  tenant?: Tenant;
  /** How a 2025-era client is handled. Defaults to serving it. */
  legacy?: "serve" | "reject";
  /** Another transport in place of the process's stdio, such as a socket, or an in-memory pair in tests. */
  transport?: Transport;
}

/**
 * Serves the registry over stdio for local clients. Node only. stdout carries the protocol, so point the logger at
 * stderr.
 */
export function serveRegistryStdio<Deps>(options: StdioOptions<Deps>): StdioServerHandle {
  const logger = options.logger === false ? undefined : options.logger;
  const scope: Scope = options.app ? { app: options.app } : "all";
  if (options.app && !options.registry.apps.has(options.app)) throw new TypeError(`Unknown app "${options.app}".`);
  checkMembers(options.registry, scope);
  for (const app of options.registry.apps.values()) {
    for (const warning of lintApp(app)) {
      logger?.warn(`MCP description lint: ${warning.target} ${warning.message}`);
    }
  }
  const caller: Caller = {};
  if (options.principal) caller.principal = options.principal;
  if (options.tenant) caller.tenant = options.tenant;
  return serveStdio(({ era }) => buildServer(options, scope, caller, { era, connected: true }), {
    legacy: options.legacy ?? "serve",
    ...(options.transport ? { transport: options.transport } : {}),
    onerror: (error) => logger?.warn("MCP stdio error", { error: String(error) }),
  });
}
