import "reflect-metadata";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import {
  Inject,
  Injectable,
  Logger as NestLogger,
  Module,
  type DynamicModule,
  type INestApplication,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type Type,
} from "@nestjs/common";
import { ModuleRef, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  createRegistry,
  devTokens,
  errorKinds,
  errors,
  resolveRequestStateKey,
  resolveRequireAuth,
  SyrinxError,
  type App,
  type Attributes,
  type Context,
  type ErrorKind,
  type IdempotencyStore,
  type Logger,
  type Principal,
  type Secret,
} from "@syrinx/core";
import { createMcpSurface } from "@syrinx/mcp";
import { createRestApp } from "@syrinx/rest";
import { createRestClient, ViewCallError, type RestClient, type RestClientOptions } from "@syrinx/ui";
import { loadViewShells, serveViewAssets, watchViewShells } from "@syrinx/ui/server";
import { buildViews, watchViews, type BuildViewsOptions } from "@syrinx/vite";

/** What an operation's handler receives as `ctx.deps`: a way into Nest's container, so handlers stay thin. */
export interface NestDeps {
  nest: { get<T>(token: Type<T> | string | symbol): T };
}

/** The context of an operation in a Nest app: `defineApp`'s handlers and `confirm` take `ctx: NestContext`. */
export type NestContext = Context<NestDeps>;

export interface SyrinxViewsOptions {
  /** The directory views are resolved from (what `buildViews` calls `root`). */
  root: string | URL;
  /** Where Vite writes bundles; defaults to `<root>/dist/views`. */
  outDir?: string;
  /** Vite plugins the views need, such as `vue()` from `@vitejs/plugin-vue`. */
  plugins?: BuildViewsOptions["plugins"];
  /** Rebuild when a view's source changes, and serve the new bundles without a restart. */
  watch?: boolean;
}

export interface SyrinxModuleOptions {
  apps: readonly App[];
  views?: SyrinxViewsOptions;
  /** Who is calling. Return undefined for an anonymous request, or throw `errors.unauthenticated`. */
  authenticate?: (request: Request) => Principal | undefined | Promise<Principal | undefined>;
  /**
   * Bearer token to principal, for demos and tests, through core's `devTokens`: the app refuses to start with it under
   * `NODE_ENV=production`. Ignored when `authenticate` is set, which is where a real app plugs its own authentication in.
   */
  principals?: Record<string, Principal>;
  /**
   * Refuse anonymous callers on REST and MCP alike (401). Defaults to on under `NODE_ENV=production` and off otherwise;
   * pass false to serve anonymous callers. On without `authenticate` or any `principals` refuses to start.
   */
  requireAuth?: boolean;
  /**
   * Encrypts the state of input round trips. Defaults to `SYRINX_REQUEST_STATE_KEY` (comma-separated, newest first, to
   * rotate); without either the host refuses to start under `NODE_ENV=production` and uses a development key otherwise.
   */
  requestStateKey?: Secret | readonly Secret[];
  /**
   * Where Idempotency-Key outcomes are kept: a shared store (`@syrinx/redis`, `@syrinx/postgres`) when more than one
   * instance runs, or `false` to stop deduplicating. Defaults to the memory store.
   */
  idempotency?: IdempotencyStore | false;
  /**
   * Receives operation logs, MCP warnings and internal errors. Defaults to Nest's logger for warnings and errors only,
   * so they follow the app's logger settings; pass `nestLogger()` for debug and info lines too, or `false` to drop all.
   */
  logger?: Logger | false;
  /** Reported to MCP clients; default to the first app's. */
  name?: string;
  version?: string;
}

export const SYRINX_OPTIONS = Symbol("SYRINX_OPTIONS");

/** Syrinx's logger shape over Nest's, under the "Syrinx" context. */
export function nestLogger(context = "Syrinx"): Logger {
  const nest = new NestLogger(context);
  const line = (message: string, attributes: Attributes = {}) =>
    Object.keys(attributes).length ? `${message} ${JSON.stringify(attributes)}` : message;
  return {
    debug: (message, attributes) => {
      nest.debug(line(message, attributes));
    },
    info: (message, attributes) => {
      nest.log(line(message, attributes));
    },
    warn: (message, attributes) => {
      nest.warn(line(message, attributes));
    },
    error: (message, attributes = {}) => {
      // Nest prints a stack passed on its own beneath the message.
      const { "error.stack": stack, ...rest } = attributes;
      if (typeof stack === "string") nest.error(line(message, rest), stack);
      else nest.error(line(message, rest));
    },
  };
}

/** Nest prints debug lines by default; without this, every MCP tool call would land in the app's console. */
const quietNestLogger = (): Logger => ({ ...nestLogger(), debug: () => undefined, info: () => undefined });

const asPath = (value: string | URL) => (typeof value === "string" ? value : fileURLToPath(value));

/** The options `buildViews` and `watchViews` take for these apps: what `scripts/build-views.ts` and the host share. */
export function viewBuild(apps: readonly App[], views: SyrinxViewsOptions) {
  const root = asPath(views.root);
  return {
    apps,
    root,
    outDir: views.outDir ?? `${root}/dist/views`,
    ...(views.plugins ? { plugins: views.plugins } : {}),
  };
}

/** Builds every view the apps declare and logs their sizes. `scripts/build-views.ts` is a call to this. */
export async function buildAllViews(apps: readonly App[], views: SyrinxViewsOptions) {
  const built = await buildViews(viewBuild(apps, views));
  console.log(`Built ${Object.keys(built.manifest.views).length} view(s)`);
  for (const [id, size] of Object.entries(built.sizes)) {
    console.log(`  ${id}: ${(size.total / 1024).toFixed(1)} KB, ${(size.gzip / 1024).toFixed(1)} KB gzipped`);
  }
  for (const warning of built.warnings) console.warn(`warning: ${warning}`);
}

/**
 * The Syrinx host as a Nest provider: REST at /api, MCP at /mcp, built views at /views. Operations reach Nest providers
 * through `ctx.deps.nest`, so the container, not the registry, owns services, config and lifetimes.
 */
@Injectable()
export class SyrinxHost implements OnApplicationBootstrap, OnApplicationShutdown {
  /** The Fetch handler for every Syrinx request; set once the application has bootstrapped. */
  fetch!: (request: Request) => Response | Promise<Response>;
  private closeWatch: (() => void) | undefined;

  // Explicit @Inject: runners without decorator metadata (tsx, esbuild) cannot infer constructor types.
  constructor(
    @Inject(SYRINX_OPTIONS) private readonly options: SyrinxModuleOptions,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {}

  /** Whether a request is Syrinx's rather than Nest's. */
  handles(pathname: string) {
    return /^\/(api|mcp|views)(\/|$)/.test(pathname);
  }

  async onApplicationBootstrap() {
    const { apps, views, requestStateKey, idempotency, logger = quietNestLogger() } = this.options;
    const deps: NestDeps = { nest: { get: (token) => this.moduleRef.get(token, { strict: false }) } };
    const authenticate = this.authenticator();
    // Configuration checks run before views build, so a bad config fails fast and leaves no watcher behind.
    const registry = createRegistry(apps, {
      requestStateKey: resolveRequestStateKey(requestStateKey),
      ...(idempotency !== undefined ? { idempotency } : {}),
    });
    const { principals } = this.options;
    const requireAuth = resolveRequireAuth(
      this.options.requireAuth,
      this.options.authenticate !== undefined || Object.keys(principals ?? {}).length > 0,
    );
    const shells = views ? await this.shells(apps, views) : undefined;
    const app = createRestApp({ registry, deps, authenticate, requireAuth, logger });
    const first = apps[0];
    const mcp = createMcpSurface({
      registry,
      deps,
      authenticate,
      requireAuth,
      logger,
      name: this.options.name ?? first?.name ?? "syrinx",
      version: this.options.version ?? first?.version ?? "0.0.0",
      ...(shells ? { views: shells } : {}),
    });
    if (shells) app.get("/views/*", (c) => serveViewAssets(shells)(c.req.raw) ?? c.notFound());
    app.all("/mcp", (c) => mcp.fetch(c.req.raw));
    app.all("/mcp/*", (c) => mcp.fetch(c.req.raw));
    this.fetch = app.fetch;
  }

  onApplicationShutdown() {
    this.closeWatch?.();
  }

  private authenticator() {
    const { authenticate, principals } = this.options;
    if (authenticate) return authenticate;
    if (principals) return devTokens(principals);
    return (request: Request): undefined => {
      if (request.headers.get("authorization")) throw errors.unauthenticated("Unknown token.");
    };
  }

  private async shells(apps: readonly App[], views: SyrinxViewsOptions) {
    const build = viewBuild(apps, views);
    if (views.watch) {
      // Vite rebuilds on edits; the shells re-read the manifest on the next open of a view.
      const watcher = await watchViews({
        ...build,
        onBuild: (result) => {
          console.log("error" in result ? `views: build failed: ${String(result.error)}` : "views: rebuilt");
        },
      });
      this.closeWatch = () => {
        watcher.close();
      };
      return await watchViewShells({ dir: build.outDir });
    }
    if (!existsSync(`${build.outDir}/manifest.json`)) {
      console.warn("No built views found; serving without UI (build the views first).");
      return undefined;
    }
    return await loadViewShells({ dir: build.outDir });
  }
}

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- a Nest module is a class that only carries metadata
export class SyrinxModule {
  /** Import once, in the root module: `imports: [SyrinxModule.forRoot({ apps: [contactsApp], views })]`. */
  static forRoot(options: SyrinxModuleOptions): DynamicModule {
    return {
      module: SyrinxModule,
      global: true,
      providers: [{ provide: SYRINX_OPTIONS, useValue: options }, SyrinxHost],
      exports: [SyrinxHost],
    };
  }
}

/** Creates the Nest application the way Syrinx needs it: Nest must not read request bodies Syrinx's routes will. */
export function createSyrinxApp(module: Type, options: { logger?: false | ("log" | "error" | "warn")[] } = {}) {
  return NestFactory.create<NestExpressApplication>(module, { bodyParser: false, ...options });
}

/**
 * Listens with Syrinx's requests going to the host and everything else to Nest's Express app, which gets the JSON body
 * parser `createSyrinxApp` left off. Resolves with the server once it is listening (port 0 picks a free one).
 */
export async function listen(app: INestApplication, port: number): Promise<Server> {
  (app as Partial<NestExpressApplication>).useBodyParser?.("json");
  await app.init();
  const host = app.get(SyrinxHost);
  const syrinx = getRequestListener((request) => host.fetch(request));
  const express = app.getHttpAdapter().getInstance() as (req: unknown, res: unknown) => void;
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (host.handles(pathname)) void syrinx(req, res);
    else express(req, res);
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}

/**
 * A typed client for another Syrinx app's REST surface, for handlers that front it: an app over a service that already
 * serves one. Pass the remote app's type only (`remoteApp<typeof contacts>({ app: "contacts", base, headers })`) and call
 * its operations as methods. A failure rethrows as the {@link SyrinxError} this app's own callers expect, so a validation
 * error keeps its field issues and a missing record stays a 404 instead of becoming a bare 500.
 */
export function remoteApp<A extends App>(options: RestClientOptions): RestClient<A> {
  const client = createRestClient<A>(options) as Record<string, (input: unknown) => Promise<unknown>>;
  return new Proxy(client, {
    get: (target, operation) => {
      const call = Reflect.get(target, operation) as ((input: unknown) => Promise<unknown>) | undefined;
      if (typeof operation !== "string" || !call) return call;
      return async (input: unknown) => {
        try {
          return await call(input);
        } catch (error) {
          throw fromRemote(error);
        }
      };
    },
  }) as unknown as RestClient<A>;
}

function fromRemote(error: unknown): unknown {
  if (!(error instanceof ViewCallError)) return error;
  if (error.kind in errorKinds) return new SyrinxError(error.kind as ErrorKind, error.message, error.issues);
  // `unreachable` (the service is down) and `input_required` (it asked a question nobody can answer here).
  return new SyrinxError(error.kind === "unreachable" ? "upstream" : "internal", error.message, error.issues);
}
