import { isVisible, SyrinxError, type InvokeOptions, type Registry } from "@syrinx/core";
import { Hono, type Context } from "hono";

export interface RestOptions<Deps = unknown> {
  registry: Registry;
  deps?: Deps;
}

/** RFC 9457 problem type URIs; stable across releases. */
const problemType = (kind: string) => `urn:syrinx:problem:${kind}`;

function problem(c: Context, error: unknown) {
  const e = error instanceof SyrinxError ? error : new SyrinxError("internal", "Internal error");
  const body = {
    type: problemType(e.kind),
    title: e.kind,
    status: e.status,
    detail: e.message,
    ...(e.issues.length ? { errors: e.issues } : {}),
  };
  return c.body(JSON.stringify(body), e.status as 400, { "content-type": "application/problem+json" });
}

export function createRestApp<Deps>({ registry, deps }: RestOptions<Deps>): Hono {
  const app = new Hono();

  const invoke = async (c: Context, input: unknown) => {
    const { app: appName, op } = c.req.param() as { app: string; op: string };
    const options: InvokeOptions = {
      surface: "rest",
      signal: c.req.raw.signal,
      requestId: c.req.header("x-request-id") ?? crypto.randomUUID(),
    };
    if (deps !== undefined) options.deps = deps;
    const idempotencyKey = c.req.header("idempotency-key");
    if (idempotencyKey) options.idempotencyKey = idempotencyKey;
    const data = await registry.invoke(appName, op, input, options);
    return c.json({ resultType: "complete", data });
  };

  app.onError((error, c) => problem(c, error));
  app.notFound((c) => problem(c, new SyrinxError("not_found", `No route for ${c.req.method} ${c.req.path}.`)));

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/api", (c) =>
    c.json({
      apps: [...registry.apps.values()].map((a) => ({ name: a.name, version: a.version, href: `/api/${a.name}` })),
    }),
  );

  app.get("/api/:app", (c) => {
    const found = registry.apps.get(c.req.param("app"));
    if (!found) throw new SyrinxError("not_found", `Unknown app "${c.req.param("app")}".`);
    return c.json({
      name: found.name,
      version: found.version,
      description: found.description,
      operations: Object.entries(found.operations)
        .filter(([, o]) => isVisible(o, "rest"))
        .map(([name, o]) => ({
          name,
          description: o.description,
          annotations: o.annotations,
          href: `/api/${found.name}/ops/${name}`,
        })),
    });
  });

  app.post("/api/:app/ops/:op", async (c) => {
    const text = await c.req.text();
    let input: unknown = {};
    if (text) {
      try {
        input = JSON.parse(text);
      } catch {
        throw new SyrinxError("validation", "Request body is not valid JSON.");
      }
    }
    return invoke(c, input);
  });

  // Read-only operations may also be called with GET, taking input from the query string.
  app.get("/api/:app/ops/:op", (c) => {
    const operation = registry.get(c.req.param("app"), c.req.param("op"));
    if (operation && isVisible(operation, "rest") && !operation.annotations.readOnly) {
      return c.body(null, 405, { allow: "POST" });
    }
    return invoke(c, c.req.query());
  });

  return app;
}
