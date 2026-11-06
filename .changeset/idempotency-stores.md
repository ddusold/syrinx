---
"@syrinx/core": minor
"@syrinx/rest": minor
"@syrinx/nest": minor
"@syrinx/redis": minor
"@syrinx/postgres": minor
"@syrinx/testing": minor
---

`idempotency` takes a store or `false`. Left out, it is the memory store (the registry warns under `NODE_ENV=production`, since other instances do not share it); `false` stops deduplicating and drops `Idempotency-Key` from OpenAPI. `@syrinx/nest` accepts the same option instead of always using the memory store. Stores now free unfinished claims after `inFlightTtlMs` (5 minutes by default). New `@syrinx/redis` and `@syrinx/postgres` packages provide shared stores on the caller's own client, and `@syrinx/testing/stores` exports the contract suite they pass.
