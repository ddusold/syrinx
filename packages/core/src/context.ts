import type { errors } from "./errors.js";
import type { Schema } from "./schema.js";
import type { StandardSchemaV1 } from "./standard-schema.js";

/** The surfaces an operation can be reached from. */
export type Surface = "model" | "app" | "rest";

export const surfaces: readonly Surface[] = ["model", "app", "rest"];

/** Who is calling. Produced by the host's auth strategy; anonymous when there is none. */
export interface Principal {
  id: string;
  scopes: readonly string[];
  /** Raw claims from the credential, for predicates that need more than scopes. */
  claims?: Readonly<Record<string, unknown>>;
}

export const anonymous: Principal = Object.freeze({ id: "anonymous", scopes: Object.freeze([]) });

export interface Tenant {
  id: string;
}

export type Attributes = Record<string, string | number | boolean | undefined>;

/** Structured logger. Hosts adapt their own (pino, console, OpenTelemetry logs) to this shape. */
export interface Logger {
  debug(message: string, attributes?: Attributes): void;
  info(message: string, attributes?: Attributes): void;
  warn(message: string, attributes?: Attributes): void;
  error(message: string, attributes?: Attributes): void;
}

/** The subset of an OpenTelemetry span Syrinx uses, so core needs no tracing dependency. */
export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Attributes): void;
  recordException(exception: unknown): void;
  end(): void;
}

/** W3C trace context from the caller: HTTP headers on REST, `_meta` on MCP. */
export interface TraceContext {
  traceparent: string;
  tracestate?: string;
}

export interface Tracer {
  /** Starts a span, as a child of the caller's trace when `parent` is given. */
  startSpan(name: string, attributes: Attributes, parent?: TraceContext): Span;
}

const noop = () => undefined;
export const noopLogger: Logger = Object.freeze({ debug: noop, info: noop, warn: noop, error: noop });
export const noopTracer: Tracer = Object.freeze({
  startSpan: () => ({ setAttribute: noop, addEvent: noop, recordException: noop, end: noop }),
});

export interface Context<Deps = unknown> {
  /** User-provided services, injected per host. */
  deps: Deps;
  principal: Principal;
  tenant: Tenant | undefined;
  requestId: string;
  idempotencyKey: string | undefined;
  signal: AbortSignal;
  /** Logger with request, app and operation attributes already attached. */
  log: Logger;
  /** The invocation's span. The framework ends it; handlers only annotate it. */
  span: Pick<Span, "setAttribute" | "addEvent">;
  /**
   * Asks the caller to confirm before continuing. On the first run this ends the call with `input_required`; the
   * retry re-runs the handler from the top and this returns the answer. Ask before any side effects.
   */
  confirm(message: string): Promise<boolean>;
  /** Like confirm, but collects a value matching `schema`. Undefined when the caller declines. */
  ask<S extends Schema>(message: string, schema: S): Promise<StandardSchemaV1.InferOutput<S> | undefined>;
  errors: typeof errors;
}
