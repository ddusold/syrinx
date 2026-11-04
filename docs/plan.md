# Syrinx plan

Declare an app once (typed operations, resources and views) and serve it as an MCP server, a REST API with OpenAPI 3.1,
and static UI for MCP Apps hosts, iframes and ordinary pages.

Status: pre-release, Phase 3 of 5 in progress. Nothing is published to npm.

## Phases

| Phase | Scope                                                                                | Status              |
| ----- | ------------------------------------------------------------------------------------ | ------------------- |
| 1     | `@syrinx/core` pipeline, `@syrinx/rest`, `@syrinx/testing`, OpenAPI 3.1              | Done                |
| 2     | `@syrinx/mcp`: Streamable HTTP and stdio, prompts, completion, conformance in CI     | Done                |
| 3     | Views: `@syrinx/ui`, `@syrinx/ui-vue`, `@syrinx/vite`, `@syrinx/nest`, browser tests | In progress (PR #2) |
| 4     | Production hardening, `@syrinx/host`, shared stores, cross-app `uses` graph checks   | Planned             |
| 5     | `@syrinx/cli`, publishing                                                            | Planned             |

## Phase 3: decisions

- **Embed moved up from Phase 4** so view context works across apps. Cross-app `uses` graph checks stay in Phase 4.
- **Own MCP Apps channel instead of the ext-apps `App` class.** ext-apps pulls in the MCP client and zod (about 90 KB gzipped per view);
  the built-in channel keeps a Vue view near 31 KB gzipped. E2E tests run every bundle against the real ext-apps `AppBridge`, so
  protocol drift fails CI.
- **Confirmations ask inside the view, through the app-only `syrinx_view_call` tool.** Some hosts reject elicitation outside a
  chat turn and strip `_meta` from view calls. Questions come back as data, answers go back as arguments, still checked against
  the sealed `requestState`. The server answers this tool only for clients that declare the MCP Apps extension.
- **Plain stateless MCP clients** get a `confirmationToken` fallback, bound to the caller and the exact arguments.
- **`@syrinx/nest`**: the Syrinx host as a Nest module, so Nest owns the container and operations reach providers through
  `ctx.deps.nest`. `remoteApp` is a typed client for fronting another Syrinx app's REST surface.
- **Bundle size is a goal, not a gate.** Real hosts have been tested and a larger view is acceptable, but keep each app's views as
  small as practical. The size report stays in CI as information; see "Lazy parts" below.

## Phase 3: remaining before merge

- Re-check `confirm` in VS Code with the channel, and record which hosts declare the MCP Apps extension.
- Document that hosts without MCP Apps support ignore `visibility: ["app"]`, so app-only tools are visible to the model there
  (permissions still apply).

## Phase 4: production hardening (priority order)

1. **Request-state key.** Read `requestStateKey` from the environment, warn or refuse the built-in default outside development,
   and accept an array of keys (newest first) so a deploy can rotate without breaking in-flight confirmations. Applies to
   `createRegistry` and `SyrinxModule.forRoot`.
2. **Idempotency store, and a way to turn it off.** Add an `idempotency` option to `createRegistry`, `@syrinx/nest` and the host
   that takes a store or `false`. Keys are in process memory today, so across instances a retry re-runs the write and
   concurrent duplicates both run. Ship Redis and Postgres adapters, including a TTL on in-flight claims. `idempotency: false`
   disables it entirely: the `Idempotency-Key` header is ignored (no claim, no stored outcome), and the OpenAPI document stops
   advertising the header. Use it when the host sits behind a gateway that already deduplicates, or when no shared store is
   available and a silently per-process guarantee is worse than none. Today the memory store is always on and can't be removed.
3. **Log unhandled errors by default.** A non-`SyrinxError` exception answers with a bare 500 and is only recorded on the span.
   Log it (with the cause) through the configured logger on every surface, REST, MCP and view calls.
4. **Dev authentication helper.** `anonymousInDev` covers anonymous access. Add a first-class "dev principals" helper (bearer
   token to principal) that refuses `NODE_ENV=production`, and use own-property lookups so names such as `toString` are not
   treated as tokens. Audit `principals` in `@syrinx/nest` for the same.
5. **Rate limiting.** A pluggable per-principal limit in the policy pipeline, with an in-memory default and a store interface.
6. **Host and listen defaults.** `listen` and the host should bind to loopback unless told otherwise.

## Phase 4: developer experience

1. **Publish the packages**, or until then provide a `syrinx doctor` check that linked checkouts are built. Linked checkouts bring
   a second copy of Nest and Vite, which forces type casts for the Vue plugin and path maps for Nest's types.
2. **CommonJS consumers.** The packages are ESM-only with an import-only exports map, so a CommonJS Nest app needs a resolver
   hook, and loading two copies of core breaks `instanceof SyrinxError`. Either ship a `require` condition or document ESM as a
   requirement and explain the failure.
3. **Browser-safe view declarations.** A page that mounts a view over REST has to repeat the view's `operations` and `boundTo`
   because the app module pulls in server code. Export the declaration (entry-free) from a browser-safe path.
4. **Watch-mode feedback.** A failed rebuild keeps the last good bundle, which is right, but is silent unless `onBuild` is logged.
   Log it by default.
5. **Decorator metadata.** Runners without it (tsx, esbuild) need an explicit `@Inject` on every constructor parameter.
   `@syrinx/nest` does this internally; document it for users' own providers.
6. **Test depth.** `@syrinx/nest` and `@syrinx/vite` each have one test file and carry most of the integration surface.
   Add cases for error translation, authentication, request-state key handling, and watch rebuilds.

## Lazy parts

A view travels with every open, and views that include a heavy component library grow past the 512 KB guideline. Investigate
loading a view's parts on demand (a dynamic import per `ViewPart`) so a bound operation that shows one part does not ship the
rest. Success: an app with several parts opens with only the part it shows.

## Phase 5

- `@syrinx/cli`: scaffold, build views, run the gallery, run lint (`lintApp`), print OpenAPI.
- Publish with changesets.

## Known limits (decided)

- Sampling and roots are not adopted, and responses are one JSON exchange, so no mid-call progress notifications.
  `examples/conformance/expected-failures.yaml` lists the resulting conformance scenarios; CI fails if the list drifts.
- Confirmation behavior depends on host behavior. The e2e suite, run against the real `AppBridge`, is the guard. Keep it in CI.
