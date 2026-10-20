import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { buildViews } from "@syrinx/vite";
import { invoices } from "../src/app.js";
import { customers } from "../src/customers.js";

// Inside this monorepo the packages are used from source; a published app would drop the aliases.
const src = (path: string) => fileURLToPath(new URL(`../../../packages/${path}`, import.meta.url));

const { manifest, gallery } = await buildViews({
  apps: [customers, invoices],
  root: fileURLToPath(new URL("..", import.meta.url)),
  outDir: "dist/views",
  plugins: [vue()],
  vite: {
    resolve: {
      alias: [
        { find: /^@syrinx\/ui$/, replacement: src("ui/src/index.ts") },
        { find: /^@syrinx\/ui-vue$/, replacement: src("ui-vue/src/index.ts") },
      ],
    },
  },
});
console.log(`Built ${Object.keys(manifest.views).length} views; gallery at dist/views/${gallery.at(-1) ?? "(none)"}`);
