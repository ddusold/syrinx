import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@syrinx/core": src("core"),
      "@syrinx/mcp/stdio": fileURLToPath(new URL("./packages/mcp/src/stdio.ts", import.meta.url)),
      "@syrinx/mcp": src("mcp"),
      "@syrinx/nest": src("nest"),
      "@syrinx/postgres": src("postgres"),
      "@syrinx/redis": src("redis"),
      "@syrinx/rest": src("rest"),
      "@syrinx/testing/stores": fileURLToPath(new URL("./packages/testing/src/stores.ts", import.meta.url)),
      "@syrinx/testing": src("testing"),
      "@syrinx/ui/server": fileURLToPath(new URL("./packages/ui/src/server.ts", import.meta.url)),
      "@syrinx/ui-vue": src("ui-vue"),
      "@syrinx/ui": src("ui"),
      "@syrinx/vite": src("vite"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "examples/*/src/**/*.test.ts"],
  },
});
