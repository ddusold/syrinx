import type { Operation } from "./app.js";
import { canonicalJson, sha256 } from "./crypto.js";
import { toJsonSchema } from "./schema.js";
import type { StandardSchemaV1 } from "./standard-schema.js";

/**
 * Origins a view may reach, as MCP Apps declares them on the `ui://` resource. Hosts build the iframe's Content
 * Security Policy from these; anything not listed is blocked.
 */
export interface ViewCsp {
  /** Origins for fetch and WebSocket connections. */
  connectDomains?: readonly string[];
  /** Origins for scripts, styles, images and fonts. */
  resourceDomains?: readonly string[];
  /** Origins for nested iframes. */
  frameDomains?: readonly string[];
}

/** An operation whose results render a view, optionally showing only one named part of a composite view. */
export type ViewBinding<Op extends string = string> = Op | { op: Op; component: string };

/** Sample data for the gallery page and visual tests. */
export interface ViewExample {
  title: string;
  /** What a bound operation would return. */
  data: unknown;
  /** The part of a composite view to show, as a `component` binding would select it. */
  component?: string;
}

/** A view as declared with `view()`, before `defineApp` gives it its app and name. */
export interface ViewDefinition<Bound extends string = string, Calls extends string = string> {
  readonly title?: string;
  readonly description?: string;
  /**
   * The view module, resolved at build time: `new URL("./views/InvoiceCard.vue", import.meta.url)`. Server code never
   * loads it; the build turns it into a static bundle and the server serves that.
   */
  readonly entry: URL | string;
  /** Operations whose results render this view. Each operation renders at most one view. */
  readonly boundTo?: readonly ViewBinding<Bound>[];
  /** Operations the view may call. They must be visible on the `app` surface. */
  readonly calls?: readonly Calls[];
  /**
   * Views rendered inside this one with `<Embed>`, shipped in this view's bundle: another app's views
   * (`customers.views.badge`) or, by the same object, views declared in this app.
   */
  readonly embeds?: readonly (View | ViewDefinition)[];
  /** Flags the view reads to turn behavior on or off, such as `{ actions: true }`. */
  readonly features?: Readonly<Record<string, boolean>>;
  readonly csp?: ViewCsp;
  /** Asks hosts to draw a border around the view. */
  readonly prefersBorder?: boolean;
  readonly examples?: readonly ViewExample[];
}

export interface View<Bound extends string = string, Calls extends string = string> extends Omit<
  ViewDefinition<Bound, Calls>,
  "embeds"
> {
  readonly kind: "view";
  /** Set by `defineApp`: the app that owns the view. */
  readonly app: string;
  /** Set by `defineApp`: the view's member name. */
  readonly name: string;
  readonly boundTo: readonly ViewBinding<Bound>[];
  readonly calls: readonly Calls[];
  readonly embeds: readonly View[];
  readonly features: Readonly<Record<string, boolean>>;
}

/** Declares a view. `defineApp` checks its operations and stamps it with its app and name. */
export function view<const Bound extends string = never, const Calls extends string = never>(
  def: ViewDefinition<Bound, Calls>,
): ViewDefinition<Bound, Calls> {
  return Object.freeze({ ...def });
}

/** `app/view`, the id views go by in bundles, manifests and boot data. */
export const viewId = (v: Pick<View, "app" | "name">) => `${v.app}/${v.name}`;

export const bindingOp = (b: ViewBinding) => (typeof b === "string" ? b : b.op);
export const bindingComponent = (b: ViewBinding) => (typeof b === "string" ? undefined : b.component);

/** The root view and every view it embeds, transitively, each once. Embeds are checked to be acyclic by defineApp. */
export function viewClosure(root: View): View[] {
  const seen = new Map<string, View>();
  const visit = (v: View) => {
    if (seen.has(viewId(v))) return;
    seen.set(viewId(v), v);
    v.embeds.forEach(visit);
  };
  visit(root);
  return [...seen.values()];
}

/**
 * A short fingerprint of an operation's output schema. Bound tool results carry it, so a view bundle cached by a
 * host can tell when the data it receives was shaped for a newer build.
 */
export async function schemaVersion(operation: Operation): Promise<string> {
  return (await sha256(canonicalJson(toJsonSchema(operation.output, "output")))).slice(0, 12);
}

/** What a bound tool result says about the view that renders it. */
export interface ViewResultMeta {
  /** `app/view`. */
  view: string;
  /** The operation that produced the data. */
  op: string;
  component?: string;
  schemaVersion: string;
}

/** How a view reaches one operation from inside a host. */
export interface ViewOperationRoute {
  /** The tool name on the endpoint the view was served from. */
  tool: string;
  /** Present for bound operations: the output schema fingerprint the bundle was built against. */
  schemaVersion?: string;
}

/**
 * Data the server writes into a view's shell. The bundle reads it at startup to know which view to mount and how
 * to reach the operations it calls.
 */
export interface ViewBoot {
  /** The root view, `app/view`. */
  view: string;
  /** `mcp` inside an MCP Apps host; `preview` in the gallery, with sample data and no server. */
  channel: "mcp" | "preview";
  /** Routes keyed `app.operation`, for every operation the view and its embeds call or are bound to. Operations missing here cannot be reached from where the view is served. */
  operations: Record<string, ViewOperationRoute>;
  /** Feature flags keyed `app/view`. */
  features: Record<string, Readonly<Record<string, boolean>>>;
  /** Preview channel only: the data and part to show. */
  preview?: { data: unknown; op?: string; component?: string };
}

type OutputOf<O> = O extends Operation<infer _In, infer Out> ? StandardSchemaV1.InferOutput<Out> : never;
type OpsOf<A> = A extends { operations: infer Ops } ? Ops : never;
type ViewsOf<A> = A extends { views: infer Vs } ? Vs : never;
type BoundOps<V> = V extends ViewDefinition<infer B, infer _C> ? B : never;

/**
 * The data a view receives: the output of any operation bound to it. Use in view code with a type-only import, so
 * no server code reaches the bundle: `useView<ViewData<typeof invoices, "browser">>()`.
 */
export type ViewData<A, Name extends keyof ViewsOf<A>> = OutputOf<
  OpsOf<A>[BoundOps<ViewsOf<A>[Name]> & keyof OpsOf<A>]
>;
