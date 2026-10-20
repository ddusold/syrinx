import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApp, op, view, type ViewBoot } from "@syrinx/core";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadViewShells, renderShell, serveViewAssets, type ViewManifest } from "./server.js";

const app = defineApp({
  name: "invoices",
  version: "1.0.0",
  description: "Invoices.",
  operations: {
    get: op({
      description: "Fetch one invoice.",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      annotations: { readOnly: true },
      handler: (input) => input,
    }),
  },
  views: { card: view({ title: "Invoice card", entry: "./Card.vue", boundTo: ["get"] }) },
});
const boot: ViewBoot = { view: "invoices/card", channel: "mcp", operations: {}, features: {} };

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "syrinx-views-"));
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "assets/card-abc123.js"), `console.log("</script><!-- hi");`);
  await writeFile(join(dir, "assets/card-abc123.css"), `body{color:red}`);
  const manifest: ViewManifest = {
    version: 1,
    views: { "invoices/card": { js: "assets/card-abc123.js", css: ["assets/card-abc123.css"] } },
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
});

describe("view shells", () => {
  it("escapes boot data and inline code so nothing ends the script early", () => {
    const html = renderShell({
      title: "<Card>",
      boot: { ...boot, preview: { data: { note: "</script><script>alert(1)</script>" } } },
      script: { inline: `const s = "</script>";` },
      styles: [],
    });
    expect(html).toContain("<title>&lt;Card&gt;</title>");
    expect(html.match(/<\/script>/g)).toHaveLength(2); // the boot element's and the module's own closing tags
    expect(html).toContain("\\u003c/script>");
  });

  it("inlines bundles by default", async () => {
    const shells = await loadViewShells({ dir });
    const { html, csp } = shells.render(app.views.card, boot);
    expect(csp).toBeUndefined();
    expect(html).toContain(`<style>body{color:red}</style>`);
    expect(html).toContain(`console.log("<\\/script><\\!-- hi");`);
    expect(html).toContain(`id="syrinx-root"`);
  });

  it("references hosted bundles with SRI and lists their origin for the CSP", async () => {
    const shells = await loadViewShells({ dir, baseUrl: "https://cdn.example.com/views" });
    const { html, csp } = shells.render(app.views.card, boot);
    expect(csp).toEqual({ resourceDomains: ["https://cdn.example.com"] });
    expect(html).toMatch(
      /<script type="module" src="https:\/\/cdn\.example\.com\/views\/assets\/card-abc123\.js" integrity="sha384-[\w+/=]+" crossorigin="anonymous">/,
    );
    expect(html).toMatch(
      /<link rel="stylesheet" href="https:\/\/cdn\.example\.com\/views\/assets\/card-abc123\.css" integrity="sha384-/,
    );
  });

  it("serves bundles as immutable, CORS-readable files and nothing else", async () => {
    const serve = serveViewAssets(await loadViewShells({ dir }));
    const ok = serve(new Request("http://localhost/views/assets/card-abc123.js"));
    expect(ok?.status).toBe(200);
    expect(ok?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(ok?.headers.get("access-control-allow-origin")).toBe("*");
    expect(ok?.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(await ok?.text()).toContain("console.log");
    expect(serve(new Request("http://localhost/views/manifest.json"))?.status).toBe(404);
    expect(serve(new Request("http://localhost/views/..%2F..%2Fetc%2Fpasswd"))?.status).toBe(404);
    expect(serve(new Request("http://localhost/api/x"))).toBeUndefined();
  });

  it("fails clearly for views without a bundle", async () => {
    const shells = await loadViewShells({ dir });
    expect(() => shells.render({ ...app.views.card, name: "missing" }, boot)).toThrow(/no bundle; rebuild/);
  });
});
