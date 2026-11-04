import { defineApp, op, prompt, resource, view, type Context } from "@syrinx/core";
import { z } from "zod";
import { customers } from "./customers.js";

export const Invoice = z.object({
  id: z.string(),
  customer: z.string(),
  totalCents: z.number().int().nonnegative(),
  status: z.enum(["draft", "sent"]),
});
export type Invoice = z.infer<typeof Invoice>;

/** Persistence stays in user code behind plain functions; the host injects it as `deps`. */
export interface InvoiceStore {
  find(id: string): Promise<Invoice | undefined>;
  list(filter: { status?: Invoice["status"] | undefined; limit: number }): Promise<Invoice[]>;
  insert(fields: Omit<Invoice, "id" | "status">): Promise<Invoice>;
  markSent(id: string): Promise<Invoice>;
}

export interface Deps {
  store: InvoiceStore;
}

type Ctx = Context<Deps>;

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function load(ctx: Ctx, id: string) {
  const invoice = await ctx.deps.store.find(id);
  if (!invoice) throw ctx.errors.notFound(`No invoice ${id}.`);
  return invoice;
}

async function loadDraft(ctx: Ctx, id: string) {
  const invoice = await load(ctx, id);
  if (invoice.status !== "draft") throw ctx.errors.conflict(`Invoice ${id} was already sent.`);
  return invoice;
}

export const invoices = defineApp({
  name: "invoices",
  version: "1.0.0",
  description: "Create, look up and send customer invoices.",
  operations: {
    get: op({
      description: "Fetch one invoice by id. Use when the id is known.",
      input: z.object({ id: z.string().min(1) }),
      output: Invoice,
      annotations: { readOnly: true },
      permissions: ["invoices:read"],
      handler: ({ id }, ctx: Ctx) => load(ctx, id),
    }),

    list: op({
      description: "List invoices, newest first, optionally filtered by status.",
      input: z.object({
        status: z.enum(["draft", "sent"]).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      output: z.object({ items: z.array(Invoice) }),
      annotations: { readOnly: true },
      permissions: ["invoices:read"],
      handler: async ({ status, limit }, ctx: Ctx) => ({ items: await ctx.deps.store.list({ status, limit }) }),
    }),

    create: op({
      description: "Create a draft invoice for a customer.",
      input: z.object({ customer: z.string().min(1), totalCents: z.number().int().positive() }),
      output: Invoice,
      visibility: ["model", "app", "rest"],
      permissions: ["invoices:write"],
      handler: (fields, ctx: Ctx) => ctx.deps.store.insert(fields),
    }),

    send: op({
      description: "Email a draft invoice to its customer. Asks the user to confirm first.",
      input: z.object({ id: z.string().min(1) }),
      output: Invoice,
      annotations: { idempotent: true },
      visibility: ["model", "app", "rest"],
      permissions: ["invoices:write"],
      // Runs before the handler on every round, so it only reads; declining fails the call as `cancelled`.
      confirm: async ({ id }, ctx: Ctx) => {
        const invoice = await loadDraft(ctx, id);
        return `Send invoice ${id} for ${dollars(invoice.totalCents)} to ${invoice.customer}?`;
      },
      // Runs once, after the user confirmed.
      handler: async ({ id }, ctx: Ctx) => {
        await loadDraft(ctx, id);
        return ctx.deps.store.markSent(id);
      },
    }),
  },

  resources: {
    invoice: resource({
      uri: "invoice://{id}",
      description: "One invoice as JSON, addressed by its id.",
      output: Invoice,
      permissions: ["invoices:read"],
      read: ({ id }, ctx: Ctx) => load(ctx, id),
    }),
  },

  views: {
    // One composite view: the list and the detail share a selection, and the detail embeds the customers badge.
    browser: view({
      title: "Invoices",
      entry: new URL("./views/InvoiceBrowser.vue", import.meta.url),
      boundTo: ["list", { op: "get", component: "detail" }],
      calls: ["list", "get", "send"],
      embeds: [customers.views.badge],
      features: { actions: true },
      examples: [
        {
          title: "Two invoices",
          data: {
            items: [
              { id: "inv_2", customer: "Globex", totalCents: 4500, status: "sent" },
              { id: "inv_1", customer: "Acme Corp", totalCents: 120000, status: "draft" },
            ],
          },
        },
        {
          title: "One invoice, detail only",
          component: "detail",
          data: { id: "inv_1", customer: "Acme Corp", totalCents: 120000, status: "draft" },
        },
      ],
    }),
  },

  prompts: {
    chase: prompt({
      title: "Chase payment",
      description: "Draft a polite payment reminder for an unpaid invoice.",
      args: z.object({ id: z.string().min(1).describe("Invoice id, such as inv_1.") }),
      permissions: ["invoices:read"],
      // Suggests sent (so unpaid and awaited) invoice ids as the user types.
      complete: {
        id: async (value, _context, ctx: Ctx) =>
          (await ctx.deps.store.list({ status: "sent", limit: 100 }))
            .map((i) => i.id)
            .filter((id) => id.startsWith(value)),
      },
      render: async ({ id }, ctx: Ctx) => {
        const invoice = await load(ctx, id);
        return `Write a short, friendly email to ${invoice.customer} reminding them that invoice ${id} for ${dollars(invoice.totalCents)} is due.`;
      },
    }),
  },
});
