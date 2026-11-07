---
"@syrinx/core": minor
"@syrinx/nest": minor
---

Core adds `devTokens({ token: principal })`, a development-only `authenticate` for demos and tests. It reads `Authorization: Bearer <token>` (scheme case-insensitive) and looks the token up among the map's own properties only, so `toString` or `__proto__` are not tokens. No header, or an empty one, is anonymous; an unknown token or another scheme is `unauthenticated`. It throws at creation under `NODE_ENV=production`. `@syrinx/nest`'s `principals` option now goes through it, so a module configured with `principals` refuses to start in production; before, inherited names such as `toString` passed as tokens. Without `principals` or `authenticate`, any token is still refused.
