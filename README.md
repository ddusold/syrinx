# Syrinx

Declare an app once (typed operations, resources and views) and Syrinx serves it as a spec-compliant MCP server, a standard REST API with OpenAPI 3.1, and static UI for MCP Apps hosts, iframes and your own pages.

> **Status:** Phase 1 of 5, pre-release. Nothing is published to npm yet.

## Packages

| Package                                        | Contents                                                                                               | Status     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------- |
| `@syrinx/core`                                 | `defineApp`, `op`, `resource`, JSON Schema conversion, policy pipeline, input round trips, idempotency | Phase 1    |
| `@syrinx/rest`                                 | REST surface on Hono: catalog, manifests, envelope, problem+json, resources, OpenAPI 3.1               | Phase 1    |
| `@syrinx/testing`                              | In-process and REST clients, parity checks                                                             | Phase 1    |
| `@syrinx/mcp`                                  | MCP projection on the TypeScript SDK v2                                                                | Phase 2    |
| `@syrinx/ui`, `@syrinx/ui-vue`, `@syrinx/vite` | View contract, Vue binding, build plugin                                                               | Phase 3    |
| `@syrinx/host`, `@syrinx/cli`                  | Host, CLI                                                                                              | Phases 4–5 |

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
// POST /api/invoices/ops/get {"id":"inv_1"}
// -> {"resultType":"complete","data":{"id":"inv_1","totalCents":1200},"meta":{"requestId":"…"}}
```

Schemas use [Standard Schema](https://standardschema.dev), so Zod, Valibot and ArkType all work.

## Development

Requires Node 20+ and pnpm 10.

```sh
pnpm install
pnpm typecheck
pnpm lint      # ESLint with typed typescript-eslint rules
pnpm format    # Prettier; CI runs format:check
pnpm test
pnpm build
pnpm smoke   # runtime smoke test; CI also runs it under Bun and Deno
pnpm lint:openapi   # Spectral on the example's generated OpenAPI (Node 22+)
```

Run the example app with `pnpm --filter @syrinx/example-invoices start` (after `pnpm build`), then try `curl -H "Authorization: Bearer reader" localhost:3000/api/invoices/ops/list`. The MCP spike in `spikes/mcp-seam` serves the same registry over MCP.

`pnpm install` also sets up a pre-commit hook that runs ESLint and Prettier on staged files. Set `SKIP_SIMPLE_GIT_HOOKS=1` to bypass it.

Record changes to published packages with `pnpm changeset`.

## License

[Apache-2.0](LICENSE)
