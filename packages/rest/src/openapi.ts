import { isVisible, templateVariables, toJsonSchema, type App, type JsonSchema, type Registry } from "@syrinx/core";

export interface OpenApiOptions {
  title?: string;
  version?: string;
  description?: string;
  contact?: { name?: string; url?: string; email?: string };
  servers?: { url: string; description?: string }[];
}

export type OpenApiDocument = Record<string, unknown> & { openapi: "3.1.0"; paths: Record<string, unknown> };

const pascal = (name: string) => name.replace(/(^|[-_])([a-z0-9])/g, (_m, _sep, c: string) => c.toUpperCase());
const json = (schema: JsonSchema) => ({ "application/json": { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/**
 * The REST path for a resource URI template, or undefined when the template has no `scheme://` form to map.
 * `invoice://{id}` on app `invoices` becomes `/api/invoices/resources/invoice/{id}`.
 */
export function resourcePath(app: string, uri: string): string | undefined {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/.exec(uri);
  return match ? `/api/${app}/resources/${match[1]}/${match[2]}` : undefined;
}

const sharedSchemas: Record<string, JsonSchema> = {
  Meta: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      traceId: { type: "string", description: "Trace id from the caller's traceparent, when one was sent." },
      replayed: { type: "boolean", description: "True when an Idempotency-Key replayed an earlier outcome." },
    },
    required: ["requestId"],
  },
  FieldIssue: {
    type: "object",
    properties: { path: { type: "string" }, message: { type: "string" } },
    required: ["path", "message"],
  },
  Problem: {
    type: "object",
    description: "RFC 9457 problem details.",
    properties: {
      type: { type: "string" },
      title: { type: "string" },
      status: { type: "integer" },
      detail: { type: "string" },
      requestId: { type: "string" },
      errors: { type: "array", items: ref("FieldIssue") },
    },
    required: ["type", "title", "status"],
  },
  InputRequest: {
    oneOf: [
      {
        type: "object",
        properties: { kind: { const: "confirm" }, message: { type: "string" } },
        required: ["kind", "message"],
      },
      {
        type: "object",
        properties: { kind: { const: "ask" }, message: { type: "string" }, schema: { type: "object" } },
        required: ["kind", "message", "schema"],
      },
    ],
  },
  InputResponse: {
    type: "object",
    properties: {
      action: { enum: ["accept", "decline", "cancel"] },
      content: { type: "object" },
    },
    required: ["action"],
  },
  InputRequired: {
    type: "object",
    description: "The operation needs answers. POST them to the operation's /resume path with the echoed requestState.",
    properties: {
      resultType: { const: "input_required" },
      inputRequests: { type: "object", additionalProperties: ref("InputRequest") },
      requestState: { type: "string" },
      meta: ref("Meta"),
    },
    required: ["resultType", "inputRequests", "requestState", "meta"],
  },
};

/**
 * Inlined schemas are used as they are. A recursive schema still holds `$ref: "#"` or `#/$defs/…`, which would point
 * at the OpenAPI document's root, so it moves into components with its references rewritten.
 */
function place(schema: JsonSchema, name: string, components: Record<string, JsonSchema>): JsonSchema {
  const text = JSON.stringify(schema);
  if (!text.includes('"$ref"')) return schema;
  const { $defs, ...root } = schema as JsonSchema & { $defs?: Record<string, JsonSchema> };
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => {
        if (key !== "$ref" || typeof v !== "string") return [key, rewrite(v)];
        if (v === "#") return [key, `#/components/schemas/${name}`];
        if (v.startsWith("#/$defs/")) return [key, `#/components/schemas/${name}_${v.slice("#/$defs/".length)}`];
        return [key, v];
      }),
    );
  };
  components[name] = rewrite(root) as JsonSchema;
  for (const [def, body] of Object.entries($defs ?? {})) components[`${name}_${def}`] = rewrite(body) as JsonSchema;
  return ref(name);
}

const problemResponse = {
  description: "Problem details (RFC 9457).",
  content: { "application/problem+json": { schema: ref("Problem") } },
};

function complete(data: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: { resultType: { const: "complete" }, data, meta: ref("Meta") },
    required: ["resultType", "data", "meta"],
  };
}

function appPaths(app: App, components: Record<string, JsonSchema>) {
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = [app.name];

  for (const [name, operation] of Object.entries(app.operations)) {
    if (!isVisible(operation, "rest")) continue;
    const base = `${pascal(app.name)}${pascal(name)}`;
    const input = place(toJsonSchema(operation.input, "input"), `${base}Input`, components);
    const output = place(toJsonSchema(operation.output, "output"), `${base}Output`, components);
    const asks = operation.annotations.asks === true;
    const responses = {
      "200": asks
        ? {
            description: "The result, or the questions the operation needs answered first.",
            content: json({ oneOf: [complete(output), ref("InputRequired")] }),
          }
        : { description: "The result.", content: json(complete(output)) },
      default: problemResponse,
    };
    const write = !operation.annotations.readOnly;
    const idempotency = write
      ? [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            description: "Repeating a key replays the first outcome instead of running the operation again.",
            schema: { type: "string" },
          },
        ]
      : [];
    const path = `/api/${app.name}/ops/${name}`;

    paths[path] = {
      post: {
        operationId: `${app.name}_${name}`,
        summary: operation.description,
        description: operation.description,
        tags,
        parameters: idempotency,
        requestBody: { required: true, content: json(input) },
        responses,
      },
    };

    const properties = (toJsonSchema(operation.input, "input").properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((toJsonSchema(operation.input, "input").required ?? []) as string[]);
    if (operation.annotations.readOnly) {
      paths[path].get = {
        operationId: `${app.name}_${name}_get`,
        summary: operation.description,
        description: `${operation.description} Read-only, so it can also be called with GET, taking input from the query string.`,
        tags,
        parameters: Object.entries(properties).map(([param, schema]) => ({
          name: param,
          in: "query",
          required: required.has(param),
          schema,
        })),
        responses,
      };
    }

    if (asks)
      paths[`${path}/resume`] = {
        post: {
          operationId: `${app.name}_${name}_resume`,
          summary: `Answer the questions from an input_required result of ${app.name}.${name}.`,
          description:
            "Re-sends the original input with the echoed requestState and one response per question. The operation runs again from the start with the answers.",
          tags,
          parameters: idempotency,
          requestBody: {
            required: true,
            content: json({
              type: "object",
              properties: {
                input: input,
                requestState: { type: "string" },
                inputResponses: { type: "object", additionalProperties: ref("InputResponse") },
              },
              required: ["input", "requestState", "inputResponses"],
            }),
          },
          responses,
        },
      };
  }

  for (const [name, res] of Object.entries(app.resources)) {
    const path = resourcePath(app.name, res.uri);
    if (!path) continue;
    const output = place(toJsonSchema(res.output, "output"), `${pascal(app.name)}${pascal(name)}Resource`, components);
    paths[path] = {
      get: {
        operationId: `${app.name}_${name}_read`,
        summary: res.description ?? `Read ${app.name}.${name}.`,
        description: `${res.description ?? `Read ${app.name}.${name}.`} Addressed by the URI template ${res.uri}.`,
        tags,
        parameters: templateVariables(res.uri).map((param) => ({
          name: param,
          in: "path",
          required: true,
          schema: { type: "string" },
        })),
        responses: {
          "200": { description: "The resource.", content: json(complete(output)) },
          default: problemResponse,
        },
      },
    };
  }
  return paths;
}

/** An OpenAPI 3.1 document for every REST-visible operation and resource, or for the named apps only. */
export function createOpenApiDocument(
  registry: Registry,
  options: OpenApiOptions & { apps?: readonly string[] } = {},
): OpenApiDocument {
  const apps = [...registry.apps.values()].filter((a) => !options.apps || options.apps.includes(a.name));
  const components: Record<string, JsonSchema> = { ...sharedSchemas };
  const paths = Object.assign({}, ...apps.map((app) => appPaths(app, components))) as Record<string, unknown>;
  const single = apps.length === 1 ? apps[0] : undefined;

  return {
    openapi: "3.1.0",
    info: {
      title: options.title ?? single?.name ?? "Syrinx API",
      version: options.version ?? single?.version ?? "0.0.0",
      ...((options.description ?? single?.description)
        ? { description: options.description ?? single?.description }
        : {}),
      ...(options.contact ? { contact: options.contact } : {}),
    },
    ...(options.servers ? { servers: options.servers } : {}),
    tags: apps.map((app) => ({ name: app.name, description: app.description })),
    paths,
    components: { schemas: components },
  };
}
