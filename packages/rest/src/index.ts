import {
  isVisible,
  logUnhandled,
  matchUriTemplate,
  SyrinxError,
  toJsonSchema,
  type InvokeOptions,
  type InvokeResult,
  type Logger,
  type Principal,
  type Registry,
  type RenderResult,
  type Resume,
  type Target,
  type Tenant,
  type Tracer,
} from "@syrinx/core";
import { Hono, type Context } from "hono";
import { etag } from "hono/etag";
import { createOpenApiDocument, resourcePath, type OpenApiOptions } from "./openapi.js";
import { inputFromQuery } from "./query.js";

export { createOpenApiDocument, resourcePath } from "./openapi.js";
export type { OpenApiDocument, OpenApiOptions } from "./openapi.js";

export interface RestOptions<Deps = unknown> {
  registry: Registry;
  deps?: Deps;
  /**
   * Turns a request into a principal. Return undefined for an anonymous caller; throw `errors.unauthenticated()` for
   * credentials that are present but invalid. Defaults to treating every caller as anonymous.
   */
  authenticate?: (request: Request) => Principal | undefined | Promise<Principal | undefined>;
  resolveTenant?: (
    principal: Principal | undefined,
    request: Request,
  ) => Tenant | undefined | Promise<Tenant | undefined>;
  /**
   * Receives operation logs and internal errors (the ones callers see only as an internal error). Without it, internal
   * errors still go to console.error; `false` drops them.
   */
  logger?: Logger | false;
  tracer?: Tracer;
  /** Served at /openapi.json and /api/{app}/openapi.json. */
  openapi?: OpenApiOptions;
}

type Call = InvokeOptions & { requestId: string };

/** Base of the RFC 9457 problem type URIs; each kind gets a stable, dereferenceable URL under it. */
export const PROBLEM_TYPE_BASE = "https://ddusold.github.io/syrinx/problems/";
const problemType = (kind: string) => `${PROBLEM_TYPE_BASE}${kind}`;

const REQUEST_ID = "syrinx.requestId";

function problem(c: Context, error: unknown, logger?: Logger | false) {
  const requestId = c.get(REQUEST_ID as never) as string | undefined;
  if (!(error instanceof SyrinxError) || error.kind === "internal") {
    const { app, op, prompt } = c.req.param() as { app?: string; op?: string; prompt?: string };
    logUnhandled(logger, error, {
      "syrinx.surface": "rest",
      "syrinx.request_id": requestId,
      "syrinx.app": app,
      "syrinx.operation": op,
      "syrinx.prompt": prompt,
      "http.request.method": c.req.method,
      "url.path": c.req.path,
    });
  }
  const e = error instanceof SyrinxError ? error : new SyrinxError("internal", "Internal error");
  const body = {
    type: problemType(e.kind),
    title: e.kind,
    status: e.status,
    detail: e.message,
    ...(requestId ? { requestId } : {}),
    ...(e.issues.length ? { errors: e.issues } : {}),
  };
  const headers: Record<string, string> = { "content-type": "application/problem+json" };
  if (e.kind === "unauthenticated") headers["www-authenticate"] = "Bearer";
  return c.body(JSON.stringify(body), e.status as 400, headers);
}

async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SyrinxError("validation", "Request body is not valid JSON.");
  }
}

function parseResume(body: unknown): { input: unknown; resume: Resume } {
  const { input, requestState, inputResponses } = (body ?? {}) as Record<string, unknown>;
  if (typeof requestState !== "string" || !inputResponses || typeof inputResponses !== "object") {
    throw new SyrinxError("validation", "A resume body needs input, requestState and inputResponses.");
  }
  return { input: input ?? {}, resume: { requestState, inputResponses: inputResponses as Record<string, unknown> } };
}

const meta = (call: Call, replayed?: true) => {
  const traceId = call.traceContext?.traceparent.split("-")[1];
  return { requestId: call.requestId, ...(traceId ? { traceId } : {}), ...(replayed ? { replayed } : {}) };
};

export function createRestApp<Deps>(options: RestOptions<Deps>): Hono {
  const { registry } = options;
  const app = new Hono();
  const etags = etag();

  app.onError((error, c) => problem(c, error, options.logger));
  app.notFound((c) => problem(c, new SyrinxError("not_found", `No route for ${c.req.method} ${c.req.path}.`)));
  // Reads get ETags so clients and caches can revalidate manifests, documents and resources cheaply.
  app.use(async (c, next) => (c.req.method === "GET" ? etags(c, next) : next()));

  /** Per-request options shared by operations and resources: identity, tracing, request id. */
  const callOptions = async (c: Context): Promise<Call> => {
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.set(REQUEST_ID as never, requestId as never);
    const principal = await options.authenticate?.(c.req.raw);
    const tenant = await options.resolveTenant?.(principal, c.req.raw);
    const call: Call = { surface: "rest", signal: c.req.raw.signal, requestId };
    if (principal) call.principal = principal;
    if (tenant) call.tenant = tenant;
    if (options.deps !== undefined) call.deps = options.deps;
    if (options.logger) call.logger = options.logger;
    if (options.tracer) call.tracer = options.tracer;
    const traceparent = c.req.header("traceparent");
    if (traceparent) {
      const tracestate = c.req.header("tracestate");
      call.traceContext = tracestate ? { traceparent, tracestate } : { traceparent };
    }
    const idempotencyKey = c.req.header("idempotency-key");
    if (idempotencyKey) call.idempotencyKey = idempotencyKey;
    return call;
  };

  const envelope = (c: Context, call: Call, result: InvokeResult | RenderResult) =>
    result.resultType === "complete"
      ? c.json({
          resultType: "complete",
          data: result.data,
          meta: meta(call, "replayed" in result ? result.replayed : undefined),
        })
      : c.json({ ...result, meta: meta(call) });

  const invoke = async (c: Context, input: unknown, resume?: Resume) => {
    const { app: appName, op } = c.req.param() as { app: string; op: string };
    const call = await callOptions(c);
    if (resume) call.resume = resume;
    return envelope(c, call, await registry.invoke(appName, op, input, call));
  };

  const findApp = (name: string) => {
    const found = registry.apps.get(name);
    if (!found) throw new SyrinxError("not_found", `Unknown app "${name}".`);
    return found;
  };

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/openapi.json", (c) => c.json(createOpenApiDocument(registry, options.openapi)));

  app.get("/api", (c) =>
    c.json({
      apps: [...registry.apps.values()].map((a) => ({ name: a.name, version: a.version, href: `/api/${a.name}` })),
    }),
  );

  // The manifest lists what this caller may use, as MCP lists do; OpenAPI stays the full contract.
  app.get("/api/:app", async (c) => {
    const found = findApp(c.req.param("app"));
    const call = await callOptions(c);
    const allowed = async <T>(entries: [string, T][], target: (name: string) => Target) => {
      const keep = await Promise.all(entries.map(([name]) => registry.allows(target(name), call)));
      return entries.filter((_, i) => keep[i]);
    };
    const operations = await allowed(
      Object.entries(found.operations).filter(([, o]) => isVisible(o, "rest")),
      (operation) => ({ app: found.name, operation }),
    );
    const resources = await allowed(Object.entries(found.resources), (resource) => ({ app: found.name, resource }));
    const prompts = await allowed(Object.entries(found.prompts), (prompt) => ({ app: found.name, prompt }));
    if (registry.personalized) c.header("cache-control", "private");
    return c.json({
      name: found.name,
      version: found.version,
      description: found.description,
      openapi: `/api/${found.name}/openapi.json`,
      operations: operations.map(([name, o]) => ({
        name,
        description: o.description,
        annotations: o.annotations,
        inputSchema: toJsonSchema(o.input, "input"),
        outputSchema: toJsonSchema(o.output, "output"),
        href: `/api/${found.name}/ops/${name}`,
      })),
      resources: resources.map(([name, r]) => {
        const href = resourcePath(found.name, r.uri);
        return {
          name,
          uri: r.uri,
          ...(r.description ? { description: r.description } : {}),
          ...(r.mimeType ? { mimeType: r.mimeType } : {}),
          outputSchema: toJsonSchema(r.output, "output"),
          ...(href ? { href } : {}),
        };
      }),
      prompts: prompts.map(([name, p]) => ({
        name,
        ...(p.title ? { title: p.title } : {}),
        description: p.description,
        ...(p.args ? { argsSchema: toJsonSchema(p.args, "input") } : {}),
        href: `/api/${found.name}/prompts/${name}`,
      })),
    });
  });

  app.get("/api/:app/openapi.json", (c) => {
    const found = findApp(c.req.param("app"));
    return c.json(createOpenApiDocument(registry, { ...options.openapi, apps: [found.name] }));
  });

  app.post("/api/:app/ops/:op", async (c) => invoke(c, await readJson(c)));

  app.post("/api/:app/ops/:op/resume", async (c) => {
    const { input, resume } = parseResume(await readJson(c));
    return invoke(c, input, resume);
  });

  // Read-only operations may also be called with GET, taking typed input from the query string.
  app.get("/api/:app/ops/:op", (c) => {
    const operation = registry.get(c.req.param("app"), c.req.param("op"));
    if (!operation || !isVisible(operation, "rest")) {
      throw new SyrinxError("not_found", `Unknown operation "${c.req.param("app")}.${c.req.param("op")}".`);
    }
    if (!operation.annotations.readOnly) return c.body(null, 405, { allow: "POST" });
    return invoke(c, inputFromQuery(new URL(c.req.url), toJsonSchema(operation.input, "input")));
  });

  // Prompts render to messages; the body holds their string arguments. Prompts that ask resume like operations.
  const render = async (c: Context, args: unknown, resume?: Resume) => {
    const call = await callOptions(c);
    if (resume) call.resume = resume;
    const { app: appName, prompt } = c.req.param() as { app: string; prompt: string };
    return envelope(c, call, await registry.render(appName, prompt, args, call));
  };
  app.post("/api/:app/prompts/:prompt", async (c) => render(c, await readJson(c)));
  app.post("/api/:app/prompts/:prompt/resume", async (c) => {
    const { input, resume } = parseResume(await readJson(c));
    return render(c, input, resume);
  });

  // Suggestions for a prompt argument or resource template variable, as MCP's completion/complete.
  app.post("/api/:app/complete", async (c) => {
    const body = (await readJson(c)) as Record<string, unknown>;
    const text = (key: string) => (typeof body[key] === "string" ? body[key] : undefined);
    const prompt = text("prompt");
    const resource = text("resource");
    const argument = text("argument");
    if ((prompt === undefined) === (resource === undefined) || argument === undefined) {
      throw new SyrinxError("validation", "A completion body needs argument and exactly one of prompt or resource.");
    }
    const args = body.arguments && typeof body.arguments === "object" ? (body.arguments as Record<string, string>) : {};
    const call = await callOptions(c);
    const completion = await registry.complete(
      {
        app: c.req.param("app"),
        argument,
        value: text("value") ?? "",
        arguments: args,
        ...(prompt !== undefined ? { prompt } : { resource: resource ?? "" }),
      },
      call,
    );
    return c.json({ resultType: "complete", data: completion, meta: meta(call) });
  });

  // Resources are addressed by their URI: invoice://inv_1 is GET /api/invoices/resources/invoice/inv_1.
  app.get("/api/:app/resources/:scheme/:rest{.+}", async (c) => {
    const found = findApp(c.req.param("app"));
    const raw = new URL(c.req.url).pathname.slice(`/api/${found.name}/resources/`.length); // still percent-encoded
    const slash = raw.indexOf("/");
    const uri = `${raw.slice(0, slash)}://${raw.slice(slash + 1)}`;
    for (const [name, res] of Object.entries(found.resources)) {
      const params = matchUriTemplate(res.uri, uri);
      if (!params) continue;
      const call = await callOptions(c);
      const data = await registry.read(found.name, name, params, call);
      return c.json({ resultType: "complete", data, meta: meta(call) });
    }
    throw new SyrinxError("not_found", `No resource matches "${uri}".`);
  });

  return app;
}
