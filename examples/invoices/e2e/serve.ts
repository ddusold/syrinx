// Serves the example with built views plus the test host page. POST /e2e/reset gives each test fresh data.
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { loadViewShells } from "@syrinx/ui/server";
import { Hono } from "hono";
import { build } from "vite";
import { createInvoicesHost } from "../src/host.js";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const port = Number(process.env.PORT ?? 4319);

// Vite's build sets NODE_ENV to production when it is unset; put it back, or the host refuses the dev request-state key.
const nodeEnv = process.env.NODE_ENV;
await build({
  configFile: false,
  root: here("."),
  base: "/e2e/",
  logLevel: "warn",
  build: { outDir: here("../dist/e2e"), emptyOutDir: true, rollupOptions: { input: here("host.html") } },
});
if (nodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = nodeEnv;
const views = await loadViewShells({ dir: new URL("../dist/views/", import.meta.url) });

let host = createInvoicesHost({ views });
const app = new Hono();
app.post("/e2e/reset", (c) => {
  host = createInvoicesHost({ views });
  return c.body(null, 204);
});
app.use("/e2e/*", serveStatic({ root: here("../dist"), rewriteRequestPath: (p) => p.replace(/^\/e2e\/?/, "/e2e/") }));
app.all("*", (c) => host.app.fetch(c.req.raw));

serve({ fetch: app.fetch, port }, () => {
  console.log(`e2e host on http://localhost:${port}/e2e/host.html`);
});
