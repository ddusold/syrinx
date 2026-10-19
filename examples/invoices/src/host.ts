import {
  createMemoryIdempotencyStore,
  createRegistry,
  errors,
  type AuditRecord,
  type Logger,
  type Principal,
} from "@syrinx/core";
import { createRestApp } from "@syrinx/rest";
import { invoices, type Deps, type Invoice, type InvoiceStore } from "./app.js";

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
  requestStateKey?: string;
  audit?: (record: AuditRecord) => void;
  logger?: Logger;
}

export function createInvoicesHost(options: HostOptions = {}) {
  const deps: Deps = {
    store:
      options.store ?? createMemoryStore([{ id: "inv_1", customer: "Acme Corp", totalCents: 120000, status: "draft" }]),
  };
  const registry = createRegistry([invoices], {
    requestStateKey: options.requestStateKey ?? "dev-only-request-state-key-change-me!",
    idempotency: createMemoryIdempotencyStore(),
    ...(options.audit ? { audit: options.audit } : {}),
  });
  const app = createRestApp({
    registry,
    deps,
    authenticate,
    ...(options.logger ? { logger: options.logger } : {}),
    openapi: { title: "Invoices example", version: invoices.version },
  });
  return { registry, app, deps };
}
