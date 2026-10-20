import type { FieldIssue, ViewResultMeta } from "@syrinx/core";
import type { ContextScope } from "./context.js";

/** What the host tells a view about where it is drawn. Every field is optional; hosts fill what they know. */
export interface HostContext {
  theme?: "light" | "dark";
  displayMode?: "inline" | "fullscreen" | "pip";
  /** Fixed or maximum sizes of the container the view sits in, in CSS pixels. */
  containerDimensions?: { width?: number; maxWidth?: number; height?: number; maxHeight?: number };
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
  locale?: string;
  timeZone?: string;
  platform?: "web" | "desktop" | "mobile";
}

/** Actions a view asks of its host. Every call is an app-surface operation, with the same permissions and audit. */
export interface ViewEmit {
  /**
   * Calls an operation of the view's own app and resolves with its output. Rejects with a {@link ViewCallError}
   * when the operation fails, or cannot be reached from where the view is served.
   */
  call<T = unknown>(operation: string, input?: unknown): Promise<T>;
  /** Asks the host to open a link outside the view. */
  openLink(url: string): Promise<void>;
}

/** What the user answers to a question the server asks mid-call, as MCP elicitation results carry it. */
export interface InputAnswer {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/**
 * A question an operation asks before it finishes, such as "Send invoice inv_1?". Hosts relay view calls without
 * answering these, so the view asks the user itself: render `message` (and a form for `fields`, if any), then call
 * `answer`. The runtime retries the call with the answer.
 */
export interface InputPrompt {
  readonly message: string;
  /** A flat JSON Schema object of the fields to fill in; empty for a plain confirmation. */
  readonly fields: {
    properties?: Record<string, { type?: string; title?: string; description?: string; enum?: unknown[] }>;
    required?: string[];
  };
  answer(answer: InputAnswer): void;
}

/** Everything a view renders from. Views are pure functions of these props: no fetching of their own. */
export interface ViewProps<Data = unknown> {
  /** `app/view`. */
  readonly view: string;
  /** The bound operation's output. Undefined until the host delivers the first result. */
  readonly data: Data | undefined;
  /** Which operation produced `data`. */
  readonly source?: { op: string; component?: string };
  /** The one part of a composite view to show, when a binding selects it. Unset means show every part. */
  readonly component?: string;
  readonly features: Readonly<Record<string, boolean>>;
  readonly host: HostContext;
  /** The last failure the host reported for the bound operation, such as a tool error. */
  readonly error?: ViewCallError;
  /** A question a call is waiting on. Framework bindings render a default dialog for it. */
  readonly prompt?: InputPrompt;
  readonly emit: ViewEmit;
  /** View context providers above this view, so a child built with another framework can bind to them. */
  readonly contexts: ContextScope;
  /** Builds and mounts embedded views. */
  readonly runtime: ViewRuntime;
}

export interface MountedView {
  update(props: ViewProps): void;
  unmount(): void;
}

/**
 * The framework-neutral view contract: mount into an element, re-render on new props, clean up. Framework bindings
 * (`@syrinx/ui-vue`) produce one from a component and keep the component in `framework`, so an embed in the same
 * framework renders it inline and keeps that framework's context chain.
 */
export interface ViewModule {
  mount(el: HTMLElement, props: ViewProps): MountedView;
  /**
   * The view renders `props.prompt`, so operations it calls can ask the user inside the view. Hosts only show
   * questions during a chat turn, so without this a confirmation raised by a click is declined unseen.
   * Framework bindings set it; a bare module sets it when it renders prompts itself.
   */
  readonly handlesPrompts?: boolean;
  readonly framework?: { name: string; component: unknown };
}

/** The views a bundle carries, keyed `app/view`, and the props an embedded view gets. */
export interface ViewRuntime {
  readonly views: Readonly<Record<string, ViewModule>>;
  /** Props for an embedded view: its own app's operations and features, the parent's host and context scope. */
  childProps(view: string, data: unknown, contexts: ContextScope): ViewProps;
}

/** Questions a call must have answered before it can finish, keyed as the server keys them. */
export interface InputNeeded {
  requests: Record<string, { message: string; fields: InputPrompt["fields"] } | { unsupported: string }>;
  requestState?: string;
}

/** A result as a bridge sees it: the data, the error, or questions to answer, plus the view metadata of bound operations. */
export interface BridgeResult {
  data?: unknown;
  view?: ViewResultMeta;
  error?: ViewCallError;
  input?: InputNeeded;
}

/** Answers to the questions of an earlier round, sent with the retried call. */
export interface InputResume {
  inputResponses: Record<string, InputAnswer>;
  requestState?: string;
}

/** One way of reaching a host: MCP Apps, the gallery preview, and later an embedding page or a first-party app. */
export interface HostBridge {
  connect(): Promise<void>;
  host(): HostContext;
  onHostContext(listener: (host: HostContext) => void): void;
  /** Results the host pushes, such as the tool result that opened the view. */
  onResult(listener: (result: BridgeResult) => void): void;
  call(
    tool: string,
    input: unknown,
    options: { app: string; operation: string; resume?: InputResume; inline?: boolean },
  ): Promise<BridgeResult>;
  openLink(url: string): Promise<void>;
}

/**
 * A failed call, as the view sees it. `kind` is a Syrinx error kind (`not_found`, `forbidden`, ...), or
 * `unreachable` when the operation is not served where the view runs.
 */
export class ViewCallError extends Error {
  override readonly name = "ViewCallError";
  constructor(
    readonly kind: string,
    message: string,
    readonly issues: readonly FieldIssue[] = [],
  ) {
    super(message);
  }
}
