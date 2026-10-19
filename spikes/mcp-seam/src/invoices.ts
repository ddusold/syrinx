import { defineApp, op, resource } from "@syrinx/core";
import { z } from "zod";

const Invoice = z.object({
  id: z.string(),
  customer: z.string(),
  totalCents: z.number().int(),
  status: z.enum(["draft", "sent"]),
});

const store = new Map([["inv_1", { id: "inv_1", customer: "Acme", totalCents: 1200, status: "draft" as const }]]);

export const invoices = defineApp({
  name: "invoices",
  version: "1.0.0",
  description: "Look up and send customer invoices.",
  operations: {
    get: op({
      description: "Fetch one invoice by id. Use when the id is known.",
      input: z.object({ id: z.string().min(1) }),
      output: Invoice,
      annotations: { readOnly: true },
      handler: ({ id }, ctx) => {
        ctx.log.info("invoice lookup", { id });
        const found = store.get(id);
        if (!found) throw ctx.errors.notFound(`No invoice ${id}.`);
        return found;
      },
    }),
    send: op({
      description: "Email a draft invoice to its customer.",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), sentBy: z.string() }),
      annotations: { idempotent: true },
      visibility: ["model", "app", "rest"],
      handler: ({ id }, ctx) => ({ id, sentBy: ctx.principal.id }),
    }),
    void: op({
      description: "Void an invoice after the user confirms.",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), voided: z.boolean() }),
      annotations: { asks: true },
      visibility: ["model", "rest"],
      handler: async ({ id }, ctx) => ({ id, voided: await ctx.confirm(`Void invoice ${id}?`) }),
    }),
    list: op({
      description: "List every invoice id.",
      input: z.object({}),
      output: z.array(z.string()),
      annotations: { readOnly: true },
      handler: () => [...store.keys()],
    }),
    preview: op({
      description: "Render a draft invoice for the invoice view.",
      input: z.object({ id: z.string() }),
      output: z.object({ html: z.string() }),
      visibility: ["app"],
      handler: ({ id }) => ({ html: `<p>${id}</p>` }),
    }),
  },
  resources: {
    invoice: resource({
      uri: "invoice://{id}",
      description: "One invoice as JSON.",
      output: Invoice,
      read: ({ id }, ctx) => {
        const found = store.get(id);
        if (!found) throw ctx.errors.notFound(`No invoice ${id}.`);
        return found;
      },
    }),
  },
});
