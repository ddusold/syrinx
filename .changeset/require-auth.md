---
"@syrinx/core": minor
"@syrinx/rest": minor
"@syrinx/mcp": minor
"@syrinx/nest": minor
---

Anonymous callers are refused by default in production. `requireAuth` now defaults to on under `NODE_ENV=production` and off otherwise, on MCP (as before when on: 401 with a Bearer challenge) and on REST, which gains the option: anonymous requests to `/openapi.json`, `/api` and everything under it get a 401 problem with `WWW-Authenticate: Bearer`, while CORS preflights, `/healthz` and routes a host mounts on the same app (MCP, view assets) are left to answer for themselves. REST authenticates once per request. Pass `requireAuth: false` to serve anonymous callers, for example a public API whose spec should stay open. Requiring auth with no `authenticate` throws at startup, since every caller would be refused. `@syrinx/nest` takes one `requireAuth` option for both surfaces (counting `principals` as authentication). Core exports the shared `resolveRequireAuth`.
