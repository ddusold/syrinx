---
"@syrinx/core": minor
"@syrinx/rest": minor
"@syrinx/mcp": minor
"@syrinx/nest": minor
---

Errors that are not a `SyrinxError` are now logged where a surface turns them into a bare internal error, including errors from `authenticate` and `resolveTenant`. The entry is `logger.error("unhandled error", …)` with `error.type`, `error.message` and `error.stack` beside the request id, app and operation. Without a logger they go to `console.error`; `logger: false` on `createRestApp`, `createMcpSurface` and `serveRegistryStdio` drops them. Core exports the `logUnhandled` helper the surfaces share. `@syrinx/nest` now passes a logger to both surfaces: by default `nestLogger()`, which writes through Nest's `Logger` under the "Syrinx" context, so operation logs and MCP warnings follow the app's Nest logger settings too. Its new `logger` option takes your own logger or `false`.
