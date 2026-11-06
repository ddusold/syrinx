---
"@syrinx/core": minor
"@syrinx/rest": minor
"@syrinx/nest": minor
"@syrinx/redis": minor
"@syrinx/postgres": minor
"@syrinx/testing": minor
---

`idempotency` takes a store or `false`. Left out, it is the memory store (the registry warns under `NODE_ENV=production`, since other instances do not share it); `false` stops deduplicating and drops `Idempotency-Key` from OpenAPI. `@syrinx/nest` accepts the same option instead of always using the memory store. Stores now free unfinished claims after `inFlightTtlMs` (5 minutes by default). New `@syrinx/redis` and `@syrinx/postgres` packages provide shared stores on the caller's own client, and `@syrinx/testing/stores` exports the contract suite they pass.

`IdempotencyStore` claims now carry a token: `begin` returns `{ status: "new", token }`, and `complete(key, token, outcome)` and `release(key, token)` act only on that claim, so a request that outlived `inFlightTtlMs` cannot finish or free the claim that replaced it. When a store fails to record an outcome, the caller still gets the result and the key stays claimed. The memory store sweeps expired keys, caps itself at `maxEntries` (100,000 by default) and replays outcomes as JSON, like the shared stores. Every store refuses TTLs that are not positive whole milliseconds.
