// Spike: project a Syrinx registry onto MCP with the official TypeScript SDK v2.
// Not the real @syrinx/mcp; the decisions it led to are in the plan doc.
import {
  isVisible,
  SyrinxError,
  toJsonSchema,
  type InputRequest,
  type InputRequired,
  type InvokeOptions,
  type JsonSchema,
  type Principal,
  type Registry,
} from "@syrinx/core";
import {
  createMcpHandler,
  inputRequired,
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
  type AuthInfo,
  type CallToolResult,
  type ElicitRequestFormParams,
  type McpHttpHandler,
  type ServerContext,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";

export interface McpOptions {
  registry: Registry;
  name: string;
  version: string;
  /** Extra per-call options (deps, logger, tracer) shared with other surfaces. */
  invokeOptions?: Omit<InvokeOptions, "surface" | "principal" | "signal" | "requestId" | "traceContext">;
  /** Per-tool `_meta`, standing in for the `_meta.ui.resourceUri` that bound views will add. */
  toolMeta?: (app: string, operation: string) => Record<string, unknown> | undefined;
}

/**
 * Publishes a JSON Schema to the SDK without letting it validate. Syrinx validates in registry.invoke, so every
 * surface reports the same errors; letting the SDK validate first would answer bad input in its own format.
 */
const publishOnly = (schema: JsonSchema): StandardSchemaWithJSON => ({
  "~standard": {
    version: 1,
    vendor: "syrinx",
    validate: (value: unknown) => ({ value }),
    jsonSchema: { input: () => schema, output: () => schema },
  },
});

const principalOf = (auth: AuthInfo | undefined): Principal | undefined =>
  auth && { id: auth.clientId, scopes: auth.scopes };

function callOptions(ctx: ServerContext, base: McpOptions["invokeOptions"]): InvokeOptions {
  const options: InvokeOptions = {
    ...base,
    surface: "model",
    signal: ctx.mcpReq.signal,
    requestId: String(ctx.mcpReq.id),
  };
  const principal = principalOf(ctx.http?.authInfo);
  if (principal) options.principal = principal;
  const requestState = ctx.mcpReq.requestState<string>();
  if (typeof requestState === "string") {
    options.resume = { requestState, inputResponses: ctx.mcpReq.inputResponses ?? {} };
  }
  const meta = ctx.mcpReq._meta as Record<string, unknown> | undefined;
  if (typeof meta?.traceparent === "string") {
    options.traceContext = { traceparent: meta.traceparent };
    if (typeof meta.tracestate === "string") options.traceContext.tracestate = meta.tracestate;
  }
  return options;
}

/** Reverse-DNS `_meta` prefix for Syrinx keys, from the project's GitHub namespace. */
const META_PREFIX = "io.github.ddusold.syrinx";
/** Where error details travel in a tool result. */
export const ERROR_META_KEY = `${META_PREFIX}/error`;
/** Set on tools whose operation may answer `input_required`, so hosts know before calling. */
export const ASKS_META_KEY = `${META_PREFIX}/asks`;

/**
 * Domain errors become tool results the model can read and react to, never JSON-RPC protocol errors. Details go in
 * `_meta`, not `structuredContent`: clients validate `structuredContent` against the tool's `outputSchema`, and the
 * v1 SDK client does so even for `isError` results, so an error object there fails as a schema mismatch.
 */
function toolError(error: unknown): CallToolResult {
  const e = error instanceof SyrinxError ? error : new SyrinxError("internal", "Internal error");
  const issues = e.issues.map((i) => `${i.path || "(root)"}: ${i.message}`);
  return {
    isError: true,
    content: [{ type: "text", text: [`${e.kind}: ${e.message}`, ...issues].join("\n") }],
    _meta: { [ERROR_META_KEY]: { kind: e.kind, message: e.message, issues: e.issues } },
  };
}

/** Syrinx questions become form-mode elicitations; a confirmation is a form with no fields (accept or decline). */
const elicitation = (request: InputRequest) =>
  inputRequired.elicit({
    message: request.message,
    requestedSchema: (request.kind === "ask"
      ? request.schema
      : { type: "object", properties: {} }) as ElicitRequestFormParams["requestedSchema"],
  });

/**
 * 2026-07-28 clients get an `input_required` result and retry with answers. 2025-era clients have no way to answer
 * a stateless server (their elicitation needs an open stream), so they get a clear tool error instead.
 */
function askClient(result: InputRequired, era: "legacy" | "modern") {
  if (era === "legacy") {
    return toolError(
      new SyrinxError("validation", "This tool asks for confirmation, which needs an MCP 2026-07-28 client."),
    );
  }
  return inputRequired({
    inputRequests: Object.fromEntries(Object.entries(result.inputRequests).map(([k, r]) => [k, elicitation(r)])),
    requestState: result.requestState,
  });
}

export function buildServer(
  { registry, name, version, invokeOptions, toolMeta }: McpOptions,
  era: "legacy" | "modern" = "modern",
): McpServer {
  const server = new McpServer({ name, version });

  for (const app of registry.apps.values()) {
    for (const [opName, operation] of Object.entries(app.operations)) {
      if (!isVisible(operation, "model")) continue;
      const custom = toolMeta?.(app.name, opName);
      const meta = operation.annotations.asks ? { ...custom, [ASKS_META_KEY]: true } : custom;
      server.registerTool(
        `${app.name}_${opName}`,
        {
          description: operation.description,
          inputSchema: publishOnly(toJsonSchema(operation.input, "input")),
          outputSchema: publishOnly(toJsonSchema(operation.output, "output")),
          annotations: {
            readOnlyHint: operation.annotations.readOnly ?? false,
            destructiveHint: operation.annotations.destructive ?? !operation.annotations.readOnly,
            idempotentHint: operation.annotations.idempotent ?? false,
          },
          ...(meta ? { _meta: meta } : {}),
        },
        async (args, ctx) => {
          try {
            const result = await registry.invoke(app.name, opName, args, callOptions(ctx, invokeOptions));
            if (result.resultType === "input_required") return askClient(result, era);
            return {
              content: [{ type: "text", text: JSON.stringify(result.data) }],
              structuredContent: result.data as Record<string, unknown>,
            };
          } catch (error) {
            return toolError(error);
          }
        },
      );
    }

    for (const [resName, res] of Object.entries(app.resources)) {
      server.registerResource(
        `${app.name}_${resName}`,
        new ResourceTemplate(res.uri, { list: undefined }),
        { ...(res.description ? { description: res.description } : {}), mimeType: "application/json" },
        async (uri, variables, ctx) => {
          try {
            const data = await registry.read(app.name, resName, variables, callOptions(ctx, invokeOptions));
            return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }] };
          } catch (error) {
            if (error instanceof SyrinxError && error.kind === "not_found") {
              throw new ResourceNotFoundError(uri.href, error.message);
            }
            throw error;
          }
        },
      );
    }
  }
  return server;
}

/**
 * One fetch handler, stateless and non-streaming: every exchange is a single JSON response. Targets 2026-07-28;
 * 2025-era clients are served through the SDK's stateless fallback.
 */
export function createMcpEndpoint(options: McpOptions): McpHttpHandler {
  return createMcpHandler(({ era }) => buildServer(options, era), { legacy: "stateless", responseMode: "json" });
}
