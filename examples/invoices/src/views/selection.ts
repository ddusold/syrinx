import { defineViewContext } from "@syrinx/ui";
import type { Invoice } from "../app.js";

/** What the browser view receives: the list (from `list`) or one invoice (from `get`, detail only). */
export type BrowserData = { items: Invoice[] } | Invoice;

export const isList = (data: BrowserData | undefined): data is { items: Invoice[] } =>
  data !== undefined && "items" in data;

/** Which invoice the browser shows in detail, shared by the list, the detail and anything embedded in them. */
export const selection = defineViewContext<{ id: string | undefined }, BrowserData>({
  name: "invoices.selection",
  initial: (data) => ({ id: isList(data) ? data.items[0]?.id : data?.id }),
  // A refreshed list keeps the selection while that invoice is still in it.
  merge: (current, data) =>
    isList(data)
      ? data.items.some((i) => i.id === current.id)
        ? current
        : { id: data.items[0]?.id }
      : { id: data.id },
});

export const money = (cents: number, locale?: string) =>
  new Intl.NumberFormat(locale ?? "en-US", { style: "currency", currency: "USD" }).format(cents / 100);
