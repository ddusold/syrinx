# Syrinx

Declare an app once (typed operations, resources and views) and Syrinx serves it as a spec-compliant MCP server, a standard REST API with OpenAPI 3.1, and static UI for MCP Apps hosts, iframes and your own pages.

> **Status:** Phase 1 of 5, pre-release. Nothing is published to npm yet.

## Packages

| Package | Contents | Status |
| --- | --- | --- |
| `@syrinx/core` | `defineApp`, `op`, registry, invocation pipeline, typed errors | Started |
| `@syrinx/rest` | REST surface on Hono: catalog, manifests, envelope, problem+json | Started |
| `@syrinx/mcp` | MCP projection on the TypeScript SDK v2 | Phase 2 |
| `@syrinx/ui`, `@syrinx/ui-vue`, `@syrinx/vite` | View contract, Vue binding, build plugin | Phase 3 |
| `@syrinx/host`, `@syrinx/testing`, `@syrinx/cli` | Host, parity test clients, CLI | Phases 1–5 |

## Example

```ts
import { createRegistry, defineApp, op } from "@syrinx/core";
import { createRestApp } from "@syrinx/rest";
import { z } from "zod";

const invoices = defineApp({
  name: "invoices",
  version: "1.0.0",
  description: "Look up customer invoices.",
  operations: {
    get: op({
      description: "Fetch one invoice by id.",
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), totalCents: z.number() }),
      annotations: { readOnly: true },
      handler: ({ id }) => ({ id, totalCents: 1200 }),
    }),
  },
});

export default createRestApp({ registry: createRegistry([invoices]) });
// POST /api/invoices/ops/get {"id":"inv_1"} -> {"resultType":"complete","data":{"id":"inv_1","totalCents":1200}}
```

Schemas use [Standard Schema](https://standardschema.dev), so Zod, Valibot and ArkType all work.

## Development

Requires Node 20+ and pnpm 10.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm smoke   # runtime smoke test; CI also runs it under Bun and Deno
```

Record changes to published packages with `pnpm changeset`.

## License

[Apache-2.0](LICENSE)
