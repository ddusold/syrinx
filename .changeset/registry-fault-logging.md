---
"@syrinx/core": minor
"@syrinx/rest": patch
"@syrinx/mcp": patch
---

Idempotency-store and audit-hook failures now follow the same rules as unhandled errors: without a logger they go to `console.error` instead of being dropped, and `logger: false` silences them. The audit-hook entry now uses the shared attributes (`syrinx.app`, `syrinx.operation`, `syrinx.request_id`, `error.type`, `error.message`, `error.stack`) in place of `error`, `app` and `operation`. `InvokeOptions.logger` accepts `false`, and the REST and MCP surfaces pass their `logger: false` through to the registry.
