import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { loadViewShells, serveViewAssets } from "@syrinx/ui/server";
import { createInvoicesHost } from "./host.js";

const port = Number(process.env.PORT ?? 3000);
const requestStateKey = process.env.SYRINX_REQUEST_STATE_KEY;
const viewsDir = new URL("../dist/views/", import.meta.url);

// Views are optional: run `pnpm build:views` first to serve them. SYRINX_VIEWS=hosted serves bundles by URL with SRI
// instead of inlining them into each shell.
const shells = existsSync(new URL("manifest.json", viewsDir))
  ? await loadViewShells({
      dir: viewsDir,
      ...(process.env.SYRINX_VIEWS === "hosted" ? { baseUrl: `http://localhost:${port}/views/` } : {}),
    })
  : undefined;
if (!shells) console.log("No built views found; serving MCP without UI (run `pnpm build:views`).");

const { app } = createInvoicesHost({
  ...(requestStateKey ? { requestStateKey } : {}),
  ...(shells ? { views: shells, viewAssets: serveViewAssets(shells) } : {}),
  audit: (record) => {
    console.log(JSON.stringify({ audit: record }));
  },
});

serve({ fetch: app.fetch, port }, () => {
  console.log(
    `Invoices example on http://localhost:${port}  (try GET /api/invoices with "Authorization: Bearer reader")`,
  );
});
