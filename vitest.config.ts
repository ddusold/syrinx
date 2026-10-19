import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@syrinx/core": src("core"),
      "@syrinx/rest": src("rest"),
      "@syrinx/testing": src("testing"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "spikes/*/src/**/*.test.ts", "examples/*/src/**/*.test.ts"],
  },
});
