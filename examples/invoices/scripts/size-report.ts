import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { buildViews } from "@syrinx/vite";
import type { Plugin } from "vite";
import { invoices } from "../src/app.js";
import { customers } from "../src/customers.js";

// Prints, per view bundle, how many bytes each package contributes (before minification), largest first.

const src = (path: string) => fileURLToPath(new URL(`../../../packages/${path}`, import.meta.url));
const report: Plugin = {
  name: "size-report",
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== "chunk") continue;
      const byPkg = new Map<string, number>();
      for (const [id, m] of Object.entries(chunk.modules)) {
        const pkg =
          /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(id)?.[1] ??
          (id.includes("/packages/") ? `@syrinx/${id.split("/packages/")[1]?.split("/")[0]}` : "app");
        byPkg.set(pkg, (byPkg.get(pkg) ?? 0) + m.renderedLength);
      }
      console.log(`\n${chunk.fileName}`);
      for (const [pkg, n] of [...byPkg].sort((a, b) => b[1] - a[1]).slice(0, 12))
        console.log(`  ${(n / 1024).toFixed(1).padStart(7)} KB  ${pkg}`);
    }
  },
};
await buildViews({
  apps: [customers, invoices],
  root: fileURLToPath(new URL("..", import.meta.url)),
  outDir: "dist/size",
  gallery: false,
  plugins: [vue(), report],
  vite: {
    resolve: {
      alias: [
        { find: /^@syrinx\/ui$/, replacement: src("ui/src/index.ts") },
        { find: /^@syrinx\/ui-vue$/, replacement: src("ui-vue/src/index.ts") },
      ],
    },
  },
});
