import {
  createContextStore,
  emptyScope,
  type ContextScope,
  type ContextStore,
  type InputPrompt,
  type MountedView,
  type ViewContextDef,
  type ViewModule,
  type ViewProps,
} from "@syrinx/ui";
import {
  computed,
  createApp,
  defineComponent,
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
 * the viewport is the frame and the view can only grow. The cap is the host's `containerDimensions.maxHeight` when it
 * sends one, else `maxHeight` (default 640px). In `fullscreen` (a page, or the host's fullscreen mode) there is no cap.
 */
export const ViewFrame = defineComponent({
  name: "ViewFrame",
  props: { maxHeight: { type: Number, default: 640 } },
  setup(props, { slots }) {
    const view = useView();
    return () => {
      const host = view.value.host;
      const cap =
        host.displayMode === "fullscreen" ? undefined : (host.containerDimensions?.maxHeight ?? props.maxHeight);
      return h(
        "div",
        {
          class: "syrinx-frame",
          style: cap ? { maxHeight: `${cap}px`, overflowY: "auto", overscrollBehavior: "contain" } : undefined,
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
