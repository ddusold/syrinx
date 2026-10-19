import { serve } from "@hono/node-server";
import { createInvoicesHost } from "./host.js";

const port = Number(process.env.PORT ?? 3000);
const requestStateKey = process.env.SYRINX_REQUEST_STATE_KEY;

const { app } = createInvoicesHost({
  ...(requestStateKey ? { requestStateKey } : {}),
  audit: (record) => {
    console.log(JSON.stringify({ audit: record }));
  },
});

serve({ fetch: app.fetch, port }, () => {
  console.log(
    `Invoices example on http://localhost:${port}  (try GET /api/invoices with "Authorization: Bearer reader")`,
  );
});
