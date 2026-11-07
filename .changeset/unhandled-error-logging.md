---
"@syrinx/core": minor
"@syrinx/rest": minor
"@syrinx/mcp": minor
"@syrinx/nest": minor
---

Internal errors are now logged where a surface reports them: anything that is not a `SyrinxError`, and `SyrinxError`s of kind `internal` such as output that fails its schema. That includes errors from `authenticate` and `resolveTenant`; the standalone MCP surface now answers those with a JSON-RPC internal error (-32603) instead of letting them escape `fetch`. The entry is `logger.error("unhandled error", …)` with `error.type`, `error.message` and `error.stack` beside the request id, app and operation, prompt or resource. Without a logger they go to `console.error`; `logger: false` on `createRestApp`, `createMcpSurface` and `serveRegistryStdio` drops them, and a failing logger never replaces the error response. Core exports the `logUnhandled` helper the surfaces share. `@syrinx/nest` now passes Nest's `Logger` (context "Syrinx") to both surfaces for warnings and errors; its new `logger` option takes `nestLogger()` for debug and info lines too, your own logger, or `false`.
