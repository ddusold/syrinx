---
"@syrinx/core": minor
"@syrinx/rest": minor
"@syrinx/mcp": minor
"@syrinx/nest": minor
---

`SYRINX_LOCAL_BYPASS_AUTH=1` (or `true`) runs a server without authentication in development: REST, MCP and `@syrinx/nest` ignore credentials and treat every caller as `local`, holding every scope the apps' operations, resources and prompts declare (permission predicates still run). It warns once at startup, and it refuses to start under `NODE_ENV=production` or with a value other than 1, true, 0 or false. Core exports `localAuthBypass`, `LOCAL_BYPASS_AUTH_ENV` and `LOCAL_PRINCIPAL_ID`. `@syrinx/nest`'s `principals` now looks tokens up among the map's own properties only, so inherited names such as `toString` are no longer accepted as tokens.
