---
"@syrinx/core": minor
"@syrinx/nest": minor
---

Read the request-state key from `SYRINX_REQUEST_STATE_KEY` (comma-separated, newest first, to rotate) when `requestStateKey` is not passed. `resolveRequestStateKey` gives hosts the explicit key, then the environment, then a development key with a warning, and refuses to fall back under `NODE_ENV=production`. `@syrinx/nest` uses it, so it no longer starts in production with the built-in key, and its `requestStateKey` option accepts a list of keys.
