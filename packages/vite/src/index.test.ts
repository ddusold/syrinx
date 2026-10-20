import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp, op, view } from "@syrinx/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildViews, watchViews } from "./index.js";

const uiSource = fileURLToPath(new URL("../../ui/src/index.ts", import.meta.url));
const vite = { resolve: { alias: [{ find: /^@syrinx\/ui$/, replacement: uiSource }] } };

/** A view module needs no framework: a default export with `mount`. */
const viewSource = (text: string) =>
  `export default { mount(el) { el.textContent = ${JSON.stringify(text)}; return { update() {}, unmount() {} }; } };\n`;

async function fixture(text = "hello") {
  const root = await mkdtemp(join(tmpdir(), "syrinx-vite-"));
  const entry = join(root, "Card.js");
  await writeFile(entry, viewSource(text));
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
    views: { card: view({ entry, boundTo: ["get"], examples: [{ title: "One", data: { id: "inv_1" } }] }) },
  });
  return { root, entry, app };
}

describe("buildViews", () => {
  it("reports each bundle's size, and warns when one is over budget", async () => {
    const { root, app } = await fixture();
    const quiet = await buildViews({ apps: [app], root, outDir: "dist/views", vite });
    const size = quiet.sizes["invoices/card"];
    expect(size).toMatchObject({ css: 0 });
    expect(size?.js).toBeGreaterThan(0);
    expect(size?.total).toBe((size?.js ?? 0) + (size?.css ?? 0));
    expect(size?.gzip).toBeGreaterThan(0);
    expect(size?.gzip).toBeLessThan(size?.total ?? 0);
    expect(quiet.warnings).toEqual([]);

    const over = await buildViews({
      apps: [app],
      root,
      outDir: "dist/views",
      vite,
      budget: { bytes: 10, gzipBytes: 10 },
    });
    expect(over.warnings).toHaveLength(2);
    expect(over.warnings[0]).toMatch(/invoices\/card is .* KB, over its 0\.0 KB budget/);
    expect(over.warnings[1]).toMatch(/gzipped, over its/);

    const off = await buildViews({ apps: [app], root, outDir: "dist/views", vite, budget: false });
    expect(off.warnings).toEqual([]);
  });

  it("replaces the output only when a build succeeds, so a broken edit leaves the last good views", async () => {
    const { root, entry, app } = await fixture();
    await buildViews({ apps: [app], root, outDir: "dist/views", vite });
    const manifestBefore = await readFile(join(root, "dist/views/manifest.json"), "utf8");

    await writeFile(entry, "export default {{{ not javascript");
    await expect(buildViews({ apps: [app], root, outDir: "dist/views", vite })).rejects.toThrow();
    expect(await readFile(join(root, "dist/views/manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readdir(join(root, "dist"))).toEqual(["views"]);
  });
});

describe("watchViews", () => {
  it("builds once, then again when a view's source changes", async () => {
    const { root, entry, app } = await fixture("one");
    const builds: unknown[] = [];
    const watcher = await watchViews({
      apps: [app],
      root,
      outDir: "dist/views",
      vite,
      gallery: false,
      debounceMs: 20,
      onBuild: (result) => builds.push(result),
    });
    try {
      expect(builds).toHaveLength(1);
      const first = (await readdir(join(root, "dist/views/assets")))[0];

      await writeFile(entry, viewSource("two"));
      await vi.waitFor(
        () => {
          expect(builds.length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 15_000, interval: 50 },
      );
      const names = await readdir(join(root, "dist/views/assets"));
      expect(names).toHaveLength(1);
      expect(names[0]).not.toBe(first);
      expect((await stat(join(root, "dist/views/manifest.json"))).isFile()).toBe(true);
    } finally {
      watcher.close();
    }
  }, 30_000);
});
