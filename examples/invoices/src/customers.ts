import { defineApp, op, view, type Context } from "@syrinx/core";
import { z } from "zod";

export const Customer = z.object({
  name: z.string(),
  tier: z.enum(["standard", "gold"]),
  email: z.string(),
});
export type Customer = z.infer<typeof Customer>;

export interface CustomerDeps {
  customers: { find(name: string): Promise<Customer | undefined> };
}

/** A second app, so the invoice browser can embed a view another team owns. */
export const customers = defineApp({
  name: "customers",
  version: "1.0.0",
  description: "Look up customer records.",
  operations: {
    get: op({
      description: "Fetch one customer by exact name. Use when the name is known.",
      input: z.object({ name: z.string().min(1) }),
      output: Customer,
      annotations: { readOnly: true },
      permissions: ["invoices:read"],
      handler: async ({ name }, ctx: Context<CustomerDeps>) => {
        const customer = await ctx.deps.customers.find(name);
        if (!customer) throw ctx.errors.notFound(`No customer named ${name}.`);
        return customer;
      },
    }),
  },
  views: {
    badge: view({
      title: "Customer badge",
      entry: new URL("./views/CustomerBadge.vue", import.meta.url),
      boundTo: ["get"],
      calls: ["get"],
      examples: [{ title: "Gold customer", data: { name: "Acme Corp", tier: "gold", email: "ap@acme.test" } }],
    }),
  },
});
