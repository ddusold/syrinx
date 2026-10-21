import {
  createContextStore,
  createRestBridge,
  emptyScope,
  restBoot,
  startView,
  ViewCallError,
  type ContextScope,
  type ContextStore,
  type DisplayMode,
  type InputPrompt,
  type MountedView,
  type RestBootOptions,
  type RestBridgeOptions,
  type StartedView,
  type ViewContextDef,
  type ViewModule,
  type ViewProps,
} from "@syrinx/ui";
import {
  computed,
  createApp,
  defineComponent,
  getCurrentInstance,
  h,
  hasInjectionContext,
  inject,
  onMounted,
  onUnmounted,
  provide,
  ref,
  shallowRef,
  watch,
  type Component,
  type InjectionKey,
  type PropType,
  type Ref,
} from "vue";

const PROPS: InjectionKey<Readonly<Ref<ViewProps>>> = Symbol("syrinx.view");
const SCOPE: InjectionKey<Readonly<Ref<ContextScope>>> = Symbol("syrinx.contexts");

type Field = NonNullable<InputPrompt["fields"]["properties"]>[string];

/**
 * The default dialog for questions an operation asks mid-call (a confirmation, or a short form). Views that want
 * their own read `useView().value.prompt` and pass `prompt: false` to {@link toView}.
 */
export const InputDialog = defineComponent({
  name: "InputDialog",
  props: { prompt: { type: Object as PropType<InputPrompt>, required: true } },
  setup(props) {
    const values = ref<Record<string, unknown>>({});
    watch(
      () => props.prompt,
      () => {
        values.value = {};
      },
    );
    const fields = computed(() => Object.entries(props.prompt.fields.properties ?? {}));
    const input = (name: string, field: Field) => {
      const label = field.title ?? name;
      const set = (value: unknown) => {
        values.value = { ...values.value, [name]: value };
      };
      if (field.enum) {
        return h("label", { style: "display:grid;gap:4px" }, [
          label,
          h(
            "select",
            {
              onChange: (e: Event) => {
                set((e.target as HTMLSelectElement).value);
              },
            },
            [h("option", { value: "" }, ""), ...field.enum.map((v) => h("option", { value: String(v) }, String(v)))],
          ),
        ]);
      }
      if (field.type === "boolean") {
        return h("label", { style: "display:flex;gap:8px;align-items:center" }, [
          h("input", {
            type: "checkbox",
            onChange: (e: Event) => {
              set((e.target as HTMLInputElement).checked);
            },
          }),
          label,
        ]);
      }
      const numeric = field.type === "number" || field.type === "integer";
      return h("label", { style: "display:grid;gap:4px" }, [
        label,
        h("input", {
          type: numeric ? "number" : "text",
          onInput: (e: Event) => {
            const raw = (e.target as HTMLInputElement).value;
            set(numeric ? Number(raw) : raw);
          },
        }),
      ]);
    };
    const button = (text: string, onClick: () => void, primary = false) =>
      h(
        "button",
        {
          type: "button",
          onClick,
          style: `min-height:36px;padding:0 14px;border-radius:var(--sx-radius,8px);font:inherit;cursor:pointer;${
            primary
              ? "border:0;background:var(--sx-accent,#2f5bd3);color:var(--sx-on-accent,#fff);font-weight:600"
              : "border:1px solid var(--sx-border,#ccc);background:none;color:inherit"
          }`,
        },
        text,
      );
    return () =>
      h(
        "div",
        {
          style:
            "position:fixed;inset:0;display:grid;place-items:center;padding:16px;background:rgb(0 0 0 / 0.35);z-index:2147483647",
        },
        h(
          "div",
          {
            role: "dialog",
            "aria-modal": "true",
            "aria-label": props.prompt.message,
            style:
              "display:grid;gap:12px;width:min(100%,360px);padding:16px;border-radius:12px;background:var(--sx-bg,#fff);color:var(--sx-text,inherit);box-shadow:0 8px 32px rgb(0 0 0 / 0.25)",
          },
          [
            h("p", { style: "margin:0" }, props.prompt.message),
            ...fields.value.map(([name, field]) => input(name, field)),
            h("div", { style: "display:flex;gap:8px;justify-content:flex-end" }, [
              button(fields.value.length ? "Cancel" : "Decline", () => {
                props.prompt.answer({ action: "decline" });
              }),
              button(
                "Confirm",
                () => {
                  props.prompt.answer({ action: "accept", content: values.value });
                },
                true,
              ),
            ]),
          ],
        ),
      );
  },
});

/**
 * Turns a Vue component into a view module. The component reads its props with {@link useView}; the module keeps
 * the component so an `<Embed>` in another Vue view renders it inline, inside the same context chain.
 */
export function toView(component: Component, options: { prompt?: false } = {}): ViewModule {
  return {
    framework: { name: "vue", component },
    // The default dialog renders prompts; with `prompt: false` the component renders them itself.
    handlesPrompts: true,
    mount(el, props): MountedView {
      const current = shallowRef(props);
      const app = createApp({
        setup() {
          provide(PROPS, current);
          provide(
            SCOPE,
            computed(() => current.value.contexts),
          );
          // Always the same two children, so opening the dialog never remounts the view and loses its state.
          return () => {
            const prompt = options.prompt === false ? undefined : current.value.prompt;
            return [h(component), prompt ? h(InputDialog, { prompt }) : null];
          };
        },
      });
      app.mount(el);
      return {
        update: (next) => {
          current.value = next;
        },
        unmount: () => {
          app.unmount();
        },
      };
    },
  };
}

/**
 * The props of the view this component belongs to: data, host context, features, and `emit` to call operations.
 * In templates the ref unwraps, so `view.data` works directly.
 */
export function useView<Data = unknown>(): Readonly<Ref<ViewProps<Data>>> {
  const props = hasInjectionContext() ? inject(PROPS, null) : null;
  if (!props) throw new Error("useView() must be called inside a Syrinx view.");
  return props as Readonly<Ref<ViewProps<Data>>>;
}

/**
 * Provides a view context to everything inside it, including embedded views from other apps. Seeded from
 * `payload`; when the payload changes, the context's merge rule decides what updates.
 */
export const ViewContext = defineComponent({
  name: "ViewContext",
  props: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any context, whatever its state and payload
    context: { type: Object as PropType<ViewContextDef<any, any>>, required: true },
    payload: { type: null as unknown as PropType<unknown>, required: false },
  },
  setup(props, { slots }) {
    const store = createContextStore(props.context as ViewContextDef, props.payload);
    watch(
      () => props.payload,
      (payload) => {
        store.refresh(payload);
      },
    );
    const parent = inject(SCOPE, ref(emptyScope));
    provide(
      SCOPE,
      computed(() => parent.value.with(store)),
    );
    return () => slots.default?.();
  },
});

/**
 * Reads and writes a view context from the nearest provider. Without one, as when the view runs standalone or
 * sliced, it falls back to a local instance seeded from the view's own data.
 */
export function useViewContext<State>(
  def: ViewContextDef<State, never>,
): readonly [Readonly<Ref<State>>, ContextStore<State>["set"]] {
  const scope = inject(SCOPE, null);
  const store =
    scope?.value.find(def) ?? createContextStore(def as ViewContextDef<State>, inject(PROPS, null)?.value.data);
  const state = shallowRef(store.get());
  const stop = store.subscribe((next) => {
    state.value = next;
  });
  onUnmounted(stop);
  return [
    state,
    (next) => {
      store.set(next);
    },
  ] as const;
}

/** Renders a Vue view inside the parent's tree, with the embedded view's own props. */
const VueFrame = defineComponent({
  name: "SyrinxVueFrame",
  props: {
    child: { type: Object as PropType<ViewProps>, required: true },
    component: { type: [Object, Function] as PropType<Component>, required: true },
  },
  setup(props) {
    provide(
      PROPS,
      computed(() => props.child),
    );
    return () => h(props.component);
  },
});

/** Mounts a view built with another framework into an element, passing it the Vue context chain. */
const ForeignFrame = defineComponent({
  name: "SyrinxForeignFrame",
  props: {
    child: { type: Object as PropType<ViewProps>, required: true },
    module: { type: Object as PropType<ViewModule>, required: true },
  },
  setup(props) {
    const el = ref<HTMLElement>();
    let mounted: MountedView | undefined;
    onMounted(() => {
      if (el.value) mounted = props.module.mount(el.value, props.child);
    });
    watch(
      () => props.child,
      (child) => {
        mounted?.update(child);
      },
    );
    onUnmounted(() => {
      mounted?.unmount();
    });
    return () => h("div", { ref: el, "data-syrinx-embed": props.child.view });
  },
});

/**
 * Renders another view, `app/view`, inside this one. The embedded view must be declared in the parent's `embeds`
 * so it ships in the bundle. It calls its own app's operations and shares the view contexts above it.
 */
export const Embed = defineComponent({
  name: "Embed",
  props: {
    view: { type: String, required: true },
    data: { type: null as unknown as PropType<unknown>, required: false },
  },
  setup(props) {
    const parent = useView();
    const scope = inject(SCOPE, ref(emptyScope));
    const child = computed(() => parent.value.runtime.childProps(props.view, props.data, scope.value));
    return () => {
      const module = parent.value.runtime.views[props.view];
      if (!module) {
        return h("p", { role: "alert" }, `View ${props.view} is not in this bundle; add it to the parent's embeds.`);
      }
      const vue = module.framework?.name === "vue" ? (module.framework.component as Component) : undefined;
      return vue
        ? h(VueFrame, { child: child.value, component: vue })
        : h(ForeignFrame, { child: child.value, module });
    };
  },
});

/**
 * Caps the view's height and scrolls inside it, for views drawn in a host frame. An MCP Apps host sizes the frame to the
 * view's content, so an uncapped long view fills the chat; and `min-height: 100vh` on the content makes it worse, since
 * the viewport is the frame and the view can only grow. The cap is `maxHeight` (default 640px), lowered to the host's
 * `containerDimensions.maxHeight` when that is smaller: a host's generous limit does not lift it. The cap is also set
 * as `--frame-max-height` on the frame, so content that fills the space (a table) can size itself to fit instead of
 * scrolling inside a scrolling frame. In `fullscreen` (a page, or the host's fullscreen mode) there is no cap, and none
 * on a `mobile` host either: a scroll area inside the chat's own fights it for the finger, so the view grows and the
 * chat scrolls. `natural` asks for the same where the view knows better, such as a narrow list of cards.
 *
 * In `fullscreen` the host's own chrome (a header, the chat box) can sit over the view: the frame pads itself by the
 * host's `safeAreaInsets`, and by the device's (`env(safe-area-inset-*)`) if larger. A mobile host that sends no insets
 * gets a modest fallback, since without one the first and last lines of the view are under the chrome; set
 * `fallbackInsets` to tune it, or `{}` for none. The insets are also the `--syrinx-inset-*` variables, for content that
 * positions itself (a sticky header, a bottom bar).
 */
export const ViewFrame = defineComponent({
  name: "ViewFrame",
  props: {
    maxHeight: { type: Number, default: 640 },
    natural: { type: Boolean, default: false },
    fallbackInsets: {
      type: Object as PropType<{ top?: number; bottom?: number }>,
      default: () => ({ top: 56, bottom: 88 }),
    },
  },
  setup(props, { slots }) {
    const view = useView();
    return () => {
      const host = view.value.host;
      const fullscreen = host.displayMode === "fullscreen";
      const reported = host.safeAreaInsets;
      const insets =
        reported ??
        (fullscreen && host.platform === "mobile"
          ? { top: 0, right: 0, bottom: 0, left: 0, ...props.fallbackInsets }
          : undefined);
      const padding =
        fullscreen && insets
          ? {
              "--syrinx-inset-top": `${insets.top}px`,
              "--syrinx-inset-right": `${insets.right}px`,
              "--syrinx-inset-bottom": `${insets.bottom}px`,
              "--syrinx-inset-left": `${insets.left}px`,
              boxSizing: "border-box",
              paddingTop: `max(${insets.top}px, env(safe-area-inset-top, 0px))`,
              paddingRight: `max(${insets.right}px, env(safe-area-inset-right, 0px))`,
              paddingBottom: `max(${insets.bottom}px, env(safe-area-inset-bottom, 0px))`,
              paddingLeft: `max(${insets.left}px, env(safe-area-inset-left, 0px))`,
            }
          : undefined;
      const cap =
        host.displayMode === "fullscreen" || host.platform === "mobile" || props.natural
          ? undefined
          : Math.min(props.maxHeight, host.containerDimensions?.maxHeight ?? Infinity);
      return h(
        "div",
        {
          class: "syrinx-frame",
          style: cap
            ? {
                maxHeight: `${cap}px`,
                overflowY: "auto",
                // Chains to the host: a scroll that reaches the end of the view carries on in the chat, not stops here.
                overscrollBehavior: "auto",
                "--frame-max-height": `${cap}px`,
              }
            : padding,
        },
        slots.default?.(),
      );
    };
  },
});

/**
 * One named part of a composite view. Every part shows normally; when a tool binding selects a part with
 * `component`, only that part renders.
 */
export const ViewPart = defineComponent({
  name: "ViewPart",
  props: { name: { type: String, required: true } },
  setup(props, { slots }) {
    const view = useView();
    return () => (!view.value.component || view.value.component === props.name ? slots.default?.() : null);
  },
});

/**
 * Runs an async action with its state kept for the template: whether it is running, and what went wrong. `run` never
 * throws; a failure lands in `error` (as a {@link ViewCallError}) and `run` resolves to undefined. Wrap a call to an
 * operation (`useViewAction((input) => view.value.emit.call("create", input))`) and bind a button to `pending`.
 */
export function useViewAction<A extends unknown[], R>(action: (...args: A) => Promise<R>) {
  const pending = ref(false);
  const error = shallowRef<ViewCallError>();
  const run = async (...args: A): Promise<R | undefined> => {
    pending.value = true;
    error.value = undefined;
    try {
      return await action(...args);
    } catch (caught) {
      error.value =
        caught instanceof ViewCallError
          ? caught
          : new ViewCallError("internal", caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      pending.value = false;
    }
  };
  return { run, pending, error, reset: () => (error.value = undefined) };
}

export interface ViewPollOptions<T> {
  /** Stops polling when this is true of a result, such as a job that is no longer running. */
  until?: (value: T) => boolean;
  /** Milliseconds between polls, or a function of the poll's number (1 for the first) to back off. Defaults to 1500. */
  interval?: number | ((attempt: number) => number);
  /** Poll once straight away rather than after the first interval. Defaults to true. */
  immediate?: boolean;
  /** Stop after this many polls. Defaults to 120. */
  maxAttempts?: number;
}

/**
 * Calls `poll` again and again until `until` says it is done, for work the server does after answering (an export, an
 * import). Stops on its own when the component unmounts, on the first failure (the error is kept; call `start` to try
 * again) and after `maxAttempts`. `data` is the latest result.
 */
export function useViewPoll<T>(poll: () => Promise<T>, options: ViewPollOptions<T> = {}) {
  const data = shallowRef<T>();
  const error = shallowRef<ViewCallError>();
  const polling = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let run = 0;

  const stop = () => {
    run += 1;
    clearTimeout(timer);
    polling.value = false;
  };

  const start = () => {
    stop();
    const mine = run;
    polling.value = true;
    error.value = undefined;
    let attempt = 0;
    const delay = () =>
      typeof options.interval === "function" ? options.interval(attempt) : (options.interval ?? 1500);
    const tick = async () => {
      attempt += 1;
      try {
        const value = await poll();
        if (mine !== run) return;
        data.value = value;
        if (options.until?.(value) || attempt >= (options.maxAttempts ?? 120)) {
          stop();
          return;
        }
      } catch (caught) {
        if (mine !== run) return;
        error.value =
          caught instanceof ViewCallError
            ? caught
            : new ViewCallError("internal", caught instanceof Error ? caught.message : String(caught));
        stop();
        return;
      }
      timer = setTimeout(() => void tick(), delay());
    };
    if (options.immediate === false) timer = setTimeout(() => void tick(), delay());
    else void tick();
  };

  if (getCurrentInstance()) onUnmounted(stop);
  return { data, error, polling, start, stop };
}

const STYLE_ID = "syrinx-ui-vue-styles";
/** The little CSS the loading components need, added to the page once; kept here so they work without a stylesheet. */
function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    "@keyframes syrinx-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}",
    "@keyframes syrinx-spin{to{transform:rotate(360deg)}}",
    ".syrinx-skeleton-row{border-radius:6px;background:linear-gradient(90deg,rgba(128,128,128,.14) 25%,rgba(128,128,128,.26) 37%,rgba(128,128,128,.14) 63%);background-size:400% 100%;animation:syrinx-shimmer 1.4s ease infinite}",
    "@media (prefers-reduced-motion:reduce){.syrinx-skeleton-row{animation:none}.syrinx-spinner{animation:none!important}}",
  ].join("");
  document.head.appendChild(style);
}

/**
 * A placeholder for content that has not arrived: shimmering rows the size of what is coming, so the view does not jump
 * when it does. `rows` rows of `height` px; `widths` varies them (percentages, repeating) to look like text.
 */
export const ViewSkeleton = defineComponent({
  name: "ViewSkeleton",
  props: {
    rows: { type: Number, default: 3 },
    height: { type: Number, default: 16 },
    gap: { type: Number, default: 10 },
    widths: { type: Array as PropType<number[]>, default: () => [100, 85, 92] },
    label: { type: String, default: "Loading" },
  },
  setup(props) {
    ensureStyles();
    return () =>
      h(
        "div",
        {
          role: "status",
          "aria-busy": "true",
          "aria-label": props.label,
          style: { display: "grid", gap: `${props.gap}px` },
        },
        Array.from({ length: props.rows }, (_, i) =>
          h("div", {
            class: "syrinx-skeleton-row",
            style: { height: `${props.height}px`, width: `${props.widths[i % props.widths.length] ?? 100}%` },
          }),
        ),
      );
  },
});

/**
 * Covers its content with a veil and a spinner while the view has called one of `ops` and the call has not come back.
 * Wrap what a navigating call will replace: the click that starts it gets an answer at once, where the view would
 * otherwise sit unchanged until the result arrives. Reads `pending` from the view; or force it with `active`.
 */
export const ViewPending = defineComponent({
  name: "ViewPending",
  props: {
    ops: { type: Array as PropType<string[]>, default: () => [] },
    active: { type: Boolean, default: undefined },
    label: { type: String, default: "Loading" },
  },
  setup(props, { slots }) {
    ensureStyles();
    const view = useView();
    const busy = computed(
      () => props.active ?? view.value.pending.some((op) => props.ops.length === 0 || props.ops.includes(op)),
    );
    return () =>
      h("div", { style: { position: "relative" }, "aria-busy": busy.value ? "true" : undefined }, [
        slots.default?.(),
        busy.value
          ? h(
              "div",
              {
                role: "status",
                "aria-label": props.label,
                style: {
                  position: "absolute",
                  inset: "0",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "10px",
                  background: "color-mix(in srgb, Canvas 72%, transparent)",
                  zIndex: "20",
                },
              },
              [
                h("div", {
                  class: "syrinx-spinner",
                  style: {
                    width: "26px",
                    height: "26px",
                    border: "3px solid rgba(128,128,128,.35)",
                    borderTopColor: "currentColor",
                    borderRadius: "50%",
                    animation: "syrinx-spin .8s linear infinite",
                  },
                }),
                props.label ? h("span", { style: { fontSize: "13px", opacity: "0.8" } }, props.label) : null,
              ],
            )
          : null,
      ]);
  },
});

export interface MountVueViewOptions extends Omit<RestBridgeOptions, "view" | "bound"> {
  /** The root view, `app/view`. */
  view: string;
  /** The root view's component. */
  component: Component;
  /** Other views of the bundle, by `app/view`, that results can move the frame to. */
  views?: Record<string, Component>;
  /** The operations that render the view, and the part each shows (see {@link RestBridgeOptions.bound}). */
  bound: RestBridgeOptions["bound"];
  /** Every operation the view may call, by name or `app.operation`. */
  operations: RestBootOptions["operations"];
  features?: RestBootOptions["features"];
  hostStyles?: RestBootOptions["hostStyles"];
  /** Where to mount: a modal's body, a drawer, any element. */
  element: HTMLElement;
}

export interface MountedVueView {
  started: StartedView;
  /** Calls an operation as the view would, showing its result in the view when the operation is bound to it. */
  show<T = unknown>(operation: string, input?: unknown): Promise<T>;
  unmount(): void;
}

/**
 * Mounts a Vue view in a page that talks to the REST API, in one call: the bridge, the boot data and the runtime. For a
 * view in a modal or drawer of an ordinary site (the same view an MCP host shows in its frame). Then `show` opens it on
 * an operation: `await mounted.show("new", { filter })`. Unmount when the modal closes.
 */
export async function mountVueView(options: MountVueViewOptions): Promise<MountedVueView> {
  const { view, component, views, bound, operations, features, hostStyles, element, ...bridgeOptions } = options;
  const bridge = createRestBridge({ ...bridgeOptions, view, bound });
  const started = await startView({
    views: {
      [view]: toView(component),
      ...Object.fromEntries(Object.entries(views ?? {}).map(([id, c]) => [id, toView(c)])),
    },
    boot: restBoot({ view, operations, ...(features ? { features } : {}), ...(hostStyles ? { hostStyles } : {}) }),
    bridge,
    element,
  });
  return {
    started,
    show: <T = unknown>(operation: string, input: unknown = {}) => started.props().emit.call<T>(operation, input),
    unmount: () => {
      started.unmount();
    },
  };
}

// ─── The standard container ────────────────────────────────────────────────────────────────────────────────────────

/**
 * How the view is shown, and the way to change it: `canExpand` and `canCollapse` say whether the host offers the other
 * mode (fullscreen, or back inline) from where the view is now, and `expand`, `collapse` and `toggle` ask for it. A
 * refusal or a host that cannot change modes lands in `error`, as {@link useViewAction} keeps it.
 */
export function useDisplayMode() {
  const view = useView();
  const mode = computed<DisplayMode>(() => view.value.host.displayMode ?? "inline");
  const available = computed(() => view.value.host.availableDisplayModes ?? []);
  const canExpand = computed(() => mode.value !== "fullscreen" && available.value.includes("fullscreen"));
  const canCollapse = computed(() => mode.value === "fullscreen" && available.value.includes("inline"));
  const request = useViewAction((next: DisplayMode) => view.value.emit.requestDisplayMode(next));
  return {
    mode,
    canExpand,
    canCollapse,
    pending: request.pending,
    error: request.error,
    expand: () => request.run("fullscreen"),
    collapse: () => request.run("inline"),
    toggle: () => request.run(mode.value === "fullscreen" ? "inline" : "fullscreen"),
  };
}

interface ContainerAction {
  label: () => string;
  disabled: () => boolean;
  run: () => void;
}
interface ContainerApi {
  /** Whether the container takes actions into its menu (it shows its bar) rather than leaving them where they were put. */
  collecting: Readonly<Ref<boolean>>;
  register(action: ContainerAction): () => void;
}
const CONTAINER: InjectionKey<ContainerApi> = Symbol("syrinx.container");

const ICON = {
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  collapse: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
} as const;
const icon = (path: string, size = 18) =>
  h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    },
    [h("path", { d: path })],
  );

let containerStyled = false;
function ensureContainerStyles() {
  if (containerStyled || typeof document === "undefined") return;
  containerStyled = true;
  const style = document.createElement("style");
  style.dataset.syrinx = "container";
  style.textContent = [
    ".syrinx-container-bar{position:sticky;top:var(--syrinx-inset-top,0px);z-index:20;display:flex;align-items:center;gap:6px;padding:8px 12px;min-height:44px;box-sizing:border-box;background:var(--sx-bg,Canvas);color:var(--sx-text,CanvasText);border-bottom:1px solid var(--sx-border,rgba(128,128,128,.3))}",
    ".syrinx-container-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}",
    ".syrinx-container-btn{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}",
    ".syrinx-container-btn:hover,.syrinx-container-btn[aria-expanded=true]{background:var(--sx-surface,rgba(128,128,128,.14))}",
    ".syrinx-container-btn:disabled{opacity:.5;cursor:default}",
    ".syrinx-container-btn:focus-visible,.syrinx-container-item:focus-visible{outline:2px solid var(--sx-accent,Highlight);outline-offset:1px}",
    ".syrinx-container-menu{position:relative}",
    ".syrinx-container-popup{position:absolute;right:0;top:calc(100% + 4px);min-width:200px;padding:4px;margin:0;list-style:none;border:1px solid var(--sx-border,rgba(128,128,128,.3));border-radius:10px;background:var(--sx-bg,Canvas);color:var(--sx-text,CanvasText);box-shadow:0 8px 24px rgba(0,0,0,.18)}",
    ".syrinx-container-item{display:flex;width:100%;min-height:40px;align-items:center;padding:0 12px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
    ".syrinx-container-item:hover:not(:disabled){background:var(--sx-surface,rgba(128,128,128,.14))}",
    ".syrinx-container-item:disabled{opacity:.5;cursor:default}",
    ".syrinx-container-sep{height:1px;margin:4px 0;background:var(--sx-border,rgba(128,128,128,.3))}",
    ".syrinx-container-note{margin:0;padding:6px 12px;font-size:13px;color:var(--sx-danger,#b00020)}",
  ].join("");
  document.head.appendChild(style);
}

/**
 * An action a view offers, drawn two ways. Where there is no container taking actions (a web page), the default slot is
 * drawn in place as the page's own control, given `run` to start the action. Inside a {@link ViewContainer} that is
 * showing its bar (an MCP host), nothing is drawn in place: the action moves to the container's menu under `label`. Either
 * way it ends in `select`, so the view writes the action once.
 *
 * ```vue
 * <ViewAction label="Export" @select="exportRows" v-slot="{ run }"><button @click="run">Export</button></ViewAction>
 * ```
 * With no slot, the web page gets a plain button.
 */
export const ViewAction = defineComponent({
  name: "ViewAction",
  props: { label: { type: String, required: true }, disabled: { type: Boolean, default: false } },
  emits: ["select"],
  setup(props, { slots, emit }) {
    const container = inject(CONTAINER, null);
    const run = () => {
      if (!props.disabled) emit("select");
    };
    let release: (() => void) | undefined;
    if (container) release = container.register({ label: () => props.label, disabled: () => props.disabled, run });
    onUnmounted(() => release?.());
    return () => {
      if (container?.collecting.value) return null;
      return slots.default
        ? slots.default({ run, disabled: props.disabled })
        : h("button", { type: "button", class: "syrinx-action", disabled: props.disabled, onClick: run }, props.label);
    };
  },
});

/**
 * The standard container for a view in a host's frame: a bar across the top with Expand / Collapse (where the host offers
 * fullscreen), a menu of the view's {@link ViewAction}s, and Open in browser (where the view gives it a link). It wraps
 * {@link ViewFrame}, so it caps, pads for the host's chrome and sticks to the top of what is on screen.
 *
 * Optional: a view that does not use it is drawn bare. With `chrome="auto"` (the default) the bar shows on hosts and not on
 * a web page, where the page has its own chrome and each ViewAction is drawn where the view put it. `always` and `never`
 * force one or the other.
 */
export const ViewContainer = defineComponent({
  name: "ViewContainer",
  props: {
    title: { type: String, default: "" },
    /** A link to the same thing on the web, or a function that makes it when asked. Without one, there is no such item. */
    openInBrowser: { type: [String, Function] as PropType<string | (() => string | undefined)>, default: undefined },
    chrome: { type: String as PropType<"auto" | "always" | "never">, default: "auto" },
    expandable: { type: Boolean, default: true },
    maxHeight: { type: Number, default: 640 },
    natural: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    ensureContainerStyles();
    const view = useView();
    const display = useDisplayMode();
    const showBar = computed(
      () => props.chrome === "always" || (props.chrome === "auto" && view.value.host.platform !== "web"),
    );

    const actions = shallowRef<ContainerAction[]>([]);
    provide(CONTAINER, {
      collecting: showBar,
      register(action) {
        actions.value = [...actions.value, action];
        return () => {
          actions.value = actions.value.filter((a) => a !== action);
        };
      },
    });

    const url = () => (typeof props.openInBrowser === "function" ? props.openInBrowser() : props.openInBrowser);
    const open = useViewAction(async () => {
      const target = url();
      if (target) await view.value.emit.openLink(target);
    });

    const menuOpen = ref(false);
    const menuRoot = ref<HTMLElement>();
    const away = (event: Event) => {
      if (menuOpen.value && !menuRoot.value?.contains(event.target as Node)) menuOpen.value = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") menuOpen.value = false;
    };
    onMounted(() => {
      document.addEventListener("pointerdown", away);
      document.addEventListener("keydown", escape);
    });
    onUnmounted(() => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    });

    const choose = (run: () => void) => {
      menuOpen.value = false;
      run();
    };

    return () => {
      const body = h("div", { class: "syrinx-container-body" }, slots.default?.());
      if (!showBar.value) return h(ViewFrame, { maxHeight: props.maxHeight, natural: props.natural }, () => body);

      const items = actions.value.map((a) => ({ label: a.label(), disabled: a.disabled(), run: a.run }));
      const link = url() ? { label: "Open in browser", disabled: false, run: () => void open.run() } : undefined;
      const problem = display.error.value ?? open.error.value;

      const buttons = [
        props.expandable && display.canExpand.value
          ? h(
              "button",
              {
                type: "button",
                class: "syrinx-container-btn",
                disabled: display.pending.value,
                onClick: () => void display.expand(),
              },
              [icon(ICON.expand), "Expand"],
            )
          : null,
        props.expandable && display.canCollapse.value
          ? h(
              "button",
              {
                type: "button",
                class: "syrinx-container-btn",
                disabled: display.pending.value,
                onClick: () => void display.collapse(),
              },
              [icon(ICON.collapse), "Collapse"],
            )
          : null,
      ];
      const menu =
        items.length || link
          ? h("div", { class: "syrinx-container-menu", ref: menuRoot }, [
              h(
                "button",
                {
                  type: "button",
                  class: "syrinx-container-btn",
                  "aria-label": "More actions",
                  "aria-haspopup": "menu",
                  "aria-expanded": String(menuOpen.value),
                  onClick: () => (menuOpen.value = !menuOpen.value),
                },
                [icon(ICON.more)],
              ),
              menuOpen.value
                ? h("ul", { class: "syrinx-container-popup", role: "menu" }, [
                    ...items.map((item) =>
                      h("li", { role: "none" }, [
                        h(
                          "button",
                          {
                            type: "button",
                            role: "menuitem",
                            class: "syrinx-container-item",
                            disabled: item.disabled,
                            onClick: () => {
                              choose(item.run);
                            },
                          },
                          item.label,
                        ),
                      ]),
                    ),
                    items.length && link ? h("li", { role: "separator", class: "syrinx-container-sep" }) : null,
                    link
                      ? h("li", { role: "none" }, [
                          h(
                            "button",
                            {
                              type: "button",
                              role: "menuitem",
                              class: "syrinx-container-item",
                              onClick: () => {
                                choose(link.run);
                              },
                            },
                            link.label,
                          ),
                        ])
                      : null,
                  ])
                : null,
            ])
          : null;

      return h(ViewFrame, { maxHeight: props.maxHeight, natural: props.natural }, () => [
        h("header", { class: "syrinx-container-bar" }, [
          h("div", { class: "syrinx-container-title" }, slots.title ? slots.title() : props.title),
          ...buttons,
          menu,
        ]),
        problem ? h("p", { class: "syrinx-container-note", role: "alert" }, problem.message) : null,
        body,
      ]);
    };
  },
});
