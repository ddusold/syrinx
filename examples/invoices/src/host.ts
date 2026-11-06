import {
  createRegistry,
  errors,
  resolveRequestStateKey,
  type AuditRecord,
  type Logger,
  type Principal,
} from "@syrinx/core";
import { createMcpSurface, type ViewShells } from "@syrinx/mcp";
import { createRestApp } from "@syrinx/rest";
import { invoices, type Deps, type Invoice, type InvoiceStore } from "./app.js";
import { customers, type Customer, type CustomerDeps } from "./customers.js";

export const demoCustomers: Customer[] = [
  { name: "Acme Corp", tier: "gold", email: "ap@acme.test" },
  { name: "Globex", tier: "standard", email: "billing@globex.test" },
];

export function createMemoryStore(seed: Invoice[] = []): InvoiceStore {
  const rows = new Map(seed.map((invoice) => [invoice.id, invoice]));
  let next = rows.size + 1;
  return {
    find: (id) => Promise.resolve(rows.get(id)),
    list: ({ status, limit }) =>
      Promise.resolve(
        [...rows.values()]
          .reverse()
          .filter((i) => !status || i.status === status)
          .slice(0, limit),
      ),
    insert: (fields) => {
      const invoice: Invoice = { id: `inv_${next++}`, status: "draft", ...fields };
      rows.set(invoice.id, invoice);
      return Promise.resolve(invoice);
    },
    markSent: (id) => {
      const current = rows.get(id);
      if (!current) return Promise.reject(new Error(`No invoice ${id}.`));
      const invoice = { ...current, status: "sent" as const };
      rows.set(id, invoice);
      return Promise.resolve(invoice);
    },
  };
}

/** Demo bearer tokens. A real host plugs in its OAuth resource-server strategy here. */
export const demoPrincipals: Record<string, Principal> = {
  reader: { id: "reader", scopes: ["invoices:read"] },
  writer: { id: "writer", scopes: ["invoices:read", "invoices:write"] },
};

function authenticate(request: Request): Principal | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const principal = demoPrincipals[header.replace(/^Bearer /, "")];
  if (!principal) throw errors.unauthenticated("Unknown token.");
  return principal;
}

export interface HostOptions {
  store?: InvoiceStore;
  /** Built view shells (`loadViewShells` from `@syrinx/ui/server`). Without them MCP serves no UI. */
  views?: ViewShells;
  /** Serves hosted view bundles, when the shells reference them by URL. */
  viewAssets?: (request: Request) => Response | undefined;
  requestStateKey?: string;
  audit?: (record: AuditRecord) => void;
  logger?: Logger;
}

export function createInvoicesHost(options: HostOptions = {}) {
  const directory = new Map(demoCustomers.map((c) => [c.name, c]));
  const deps: Deps & CustomerDeps = {
    store:
      options.store ??
      createMemoryStore([
        { id: "inv_1", customer: "Acme Corp", totalCents: 120000, status: "draft" },
        { id: "inv_2", customer: "Globex", totalCents: 4500, status: "sent" },
      ]),
    customers: { find: (name) => Promise.resolve(directory.get(name)) },
  };
  const registry = createRegistry([customers, invoices], {
    requestStateKey: resolveRequestStateKey(options.requestStateKey),
    ...(options.audit ? { audit: options.audit } : {}),
  });
  const app = createRestApp({
    registry,
    deps,
    authenticate,
    ...(options.logger ? { logger: options.logger } : {}),
    openapi: {
      title: "Invoices example",
      description: "Invoices and customers served by Syrinx: one registry over REST, MCP and views.",
      version: invoices.version,
    },
  });
  // The same registry over MCP: POST /mcp serves every app, POST /mcp/invoices this one alone.
  const mcp = createMcpSurface({
    registry,
    deps,
    authenticate,
    name: "invoices-example",
    version: invoices.version,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.views ? { views: options.views } : {}),
  });
  const { viewAssets } = options;
  if (viewAssets) app.get("/views/*", (c) => viewAssets(c.req.raw) ?? c.notFound());
  app.all("/mcp", (c) => mcp.fetch(c.req.raw));
  app.all("/mcp/*", (c) => mcp.fetch(c.req.raw));
  return { registry, app, deps, mcp };
}
