import type { ViewBoot } from "@syrinx/core";
import { emptyScope, type ContextScope } from "./context.js";
import { createMcpBridge } from "./mcp.js";
import { createPreviewBridge } from "./preview.js";
import {
  ViewCallError,
  type BridgeResult,
  type InputAnswer,
  type InputNeeded,
  type InputPrompt,
  type InputResume,
  type HostBridge,
  type HostContext,
  type MountedView,
  type ViewEmit,
  type ViewFile,
  type ViewModule,
  type ViewProps,
  type ViewRuntime,
} from "./types.js";

/** Where the server writes boot data in a shell. */
export const BOOT_ELEMENT_ID = "syrinx-boot";
/** The element a shell mounts its root view into. */
export const ROOT_ELEMENT_ID = "syrinx-root";

export function readBoot(doc: Document = document): ViewBoot {
  const text = doc.getElementById(BOOT_ELEMENT_ID)?.textContent;
  if (!text) throw new Error(`This page has no #${BOOT_ELEMENT_ID} element; it is not a Syrinx view shell.`);
  return JSON.parse(text) as ViewBoot;
}

export interface StartOptions {
  /** Every view the bundle carries, keyed `app/view`: the root and what it embeds. */
  views: Record<string, ViewModule>;
  /** Defaults to the shell's boot data. */
  boot?: ViewBoot;
  /** Defaults to the bridge for the boot channel: MCP Apps, or the gallery preview. */
  bridge?: HostBridge;
  /** Defaults to the shell's root element. */
  element?: HTMLElement;
}

export interface StartedView {
  props(): ViewProps;
  unmount(): void;
}

/** Questions one call may ask in a row before the runtime gives up, matching the SDK client's cap. */
const MAX_ROUNDS = 8;

const appOf = (view: string) => view.slice(0, view.indexOf("/"));

function applyTheme(host: HostContext) {
  if (typeof document === "undefined" || !host.theme) return;
  document.documentElement.dataset.theme = host.theme;
  document.documentElement.style.colorScheme = host.theme;
}

/** A call the view can return to: what produced the view before a navigation. */
interface HistoryEntry {
  app: string;
  op: string;
  input: unknown;
}

/**
 * Starts a view bundle: connects to the host, mounts the root view, and re-renders it when the host delivers new
 * data or context. Results of bound operations, whether the host pushes them or the view calls them itself, replace
 * what the view shows: its data, and, when the result belongs to another view the bundle carries (an embed), the view
 * itself, so one frame can move between views and parts and come back with `back()`.
 */
export async function startView(options: StartOptions): Promise<StartedView> {
  const boot = options.boot ?? readBoot();
  if (!options.bridge && boot.channel === "rest") {
    throw new Error("A view booted for the rest channel needs a bridge: pass one made with createRestBridge.");
  }
  const bridge =
    options.bridge ??
    (boot.channel === "preview" ? createPreviewBridge(boot) : createMcpBridge({}, { hostStyles: boot.hostStyles }));
  const rootModule = options.views[boot.view];
  if (!rootModule) throw new Error(`The bundle has no module for view ${boot.view}.`);

  // The view showing now: the one the shell was made for, until a result belongs to another the bundle carries.
  let current = boot.view;
  const moduleOf = (view: string) => options.views[view];
  // The shown view renders prompts for itself and everything embedded in it, so its calls can ask inside the view.
  const viewCallFor = () => {
    const module = moduleOf(current);
    return module?.handlesPrompts === true && boot.viewCallTool ? { viewCall: boot.viewCallTool } : {};
  };

  const state: {
    data: unknown;
    source?: { op: string; component?: string };
    component?: string;
    error?: ViewCallError;
    prompt?: InputPrompt;
    host: HostContext;
  } = {
    data: undefined,
    host: {},
  };
  let mounted: MountedView | undefined;
  const element = options.element ?? document.getElementById(ROOT_ELEMENT_ID) ?? document.body;
  // The input of the call that produced `state.data`, for `refresh` and `back`; unset when the host opened the view and
  // did not say.
  let sourceInput: { value: unknown } | undefined;
  const history: HistoryEntry[] = [];
  let goingBack = false;
  const pending: string[] = [];

  const update = () => {
    mounted?.update(rootProps());
  };

  /** Shows `view` in the frame in place of the one showing: its module is mounted fresh, with the props as they stand. */
  const switchTo = (view: string) => {
    if (view === current) return;
    current = view;
    const module = moduleOf(view);
    if (!module) return;
    mounted?.unmount();
    mounted = module.mount(element, rootProps());
  };

  const apply = (result: BridgeResult) => {
    if (result.error) {
      state.error = result.error;
    } else {
      delete state.error;
      state.data = result.data;
      const meta = result.view;
      if (meta) {
        state.source = { op: meta.op, ...(meta.component ? { component: meta.component } : {}) };
        if (meta.component) state.component = meta.component;
        else delete state.component;
        const expected = boot.operations[`${appOf(meta.view)}.${meta.op}`]?.schemaVersion;
        if (expected && expected !== meta.schemaVersion) {
          console.warn(`[syrinx] ${meta.view} was built for another version of ${meta.op}'s output; reload the view.`);
        }
        if (moduleOf(meta.view) && meta.view !== current) {
          switchTo(meta.view);
          return;
        }
      }
    }
    update();
  };

  // Questions wait in line: one prompt shows at a time, whichever call asked.
  let asking: Promise<unknown> = Promise.resolve();
  const ask = (message: string, fields: InputPrompt["fields"]) => {
    const answered = asking.then(
      () =>
        new Promise<InputAnswer>((resolve) => {
          state.prompt = {
            message,
            fields,
            answer: (answer) => {
              delete state.prompt;
              update();
              resolve(answer);
            },
          };
          update();
        }),
    );
    asking = answered;
    return answered;
  };
  const answerAll = async (input: InputNeeded): Promise<InputResume> => {
    const inputResponses: InputResume["inputResponses"] = {};
    for (const [key, request] of Object.entries(input.requests)) {
      // Sampling and roots are not offered by views; declining lets the operation decide what to do without them.
      inputResponses[key] =
        "unsupported" in request ? { action: "decline" } : await ask(request.message, request.fields);
    }
    return { inputResponses, ...(input.requestState !== undefined ? { requestState: input.requestState } : {}) };
  };

  const needs = <K extends "downloadFile" | "sendMessage">(method: K, what: string) => {
    const fn = bridge[method];
    if (!fn) throw new ViewCallError("unreachable", `Where this view runs, it cannot ${what}.`);
    return fn.bind(bridge) as NonNullable<HostBridge[K]>;
  };

  const emitFor = (app: string): ViewEmit => ({
    async call<T>(qualified: string, input: unknown = {}) {
      // "app.operation" reaches an operation of another app (one the view embeds), as the app's own view would.
      const dot = qualified.indexOf(".");
      if (dot > 0 && qualified.slice(0, dot) !== app)
        return emitFor(qualified.slice(0, dot)).call<T>(qualified.slice(dot + 1), input);
      const operation = dot > 0 ? qualified.slice(dot + 1) : qualified;
      const route = boot.operations[`${app}.${operation}`];
      if (!route) {
        throw new ViewCallError("unreachable", `${app}.${operation} is not served where this view runs.`);
      }
      pending.push(operation);
      update();
      try {
        let result = await bridge.call(route.tool, input, { app, operation, ...viewCallFor() });
        for (let round = 1; result.input; round++) {
          if (round > MAX_ROUNDS) throw new ViewCallError("internal", `${app}.${operation} kept asking for input.`);
          const resume = await answerAll(result.input);
          result = await bridge.call(route.tool, input, { app, operation, resume, ...viewCallFor() });
        }
        if (result.error) throw result.error;
        if (result.view && moduleOf(result.view.view)) {
          // Moving to another view or part leaves a way back, when what is leaving can be repeated.
          const meta = result.view;
          const navigates = meta.view !== current || meta.component !== state.component;
          if (navigates && !goingBack && state.source && sourceInput) {
            history.push({ app: appOf(current), op: state.source.op, input: sourceInput.value });
          }
          apply(result);
          sourceInput = { value: input };
        }
        return result.data as T;
      } finally {
        pending.splice(pending.indexOf(operation), 1);
        update();
      }
    },
    openLink: (url) => bridge.openLink(url),
    downloadFile: async (file: ViewFile) => needs("downloadFile", "save files")(file),
    sendMessage: async (text: string) => needs("sendMessage", "post a message to a chat")(text),
  });

  const refresh = async () => {
    const source = state.source;
    if (!source)
      throw new ViewCallError("unreachable", "Nothing to refresh: no operation has produced this view's data.");
    if (!sourceInput) {
      throw new ViewCallError(
        "unreachable",
        `The input of ${source.op} is not known where this view runs, so it cannot be repeated.`,
      );
    }
    await emitFor(appOf(current)).call(source.op, sourceInput.value);
  };

  const back = async () => {
    const entry = history.pop();
    if (!entry) throw new ViewCallError("unreachable", "There is nothing to go back to.");
    goingBack = true;
    try {
      await emitFor(entry.app).call(entry.op, entry.input);
    } catch (error) {
      history.push(entry);
      throw error;
    } finally {
      goingBack = false;
    }
  };

  const remember = (input: unknown) => {
    sourceInput = { value: input };
  };

  const runtime: ViewRuntime = {
    views: options.views,
    childProps: (view, data, contexts) => ({
      view,
      data,
      features: boot.features[view] ?? {},
      host: state.host,
      emit: emitFor(appOf(view)),
      pending,
      canGoBack: history.length > 0,
      back,
      remember,
      refresh,
      contexts,
      runtime,
    }),
  };

  const rootProps = (contexts: ContextScope = emptyScope): ViewProps => ({
    ...state,
    view: current,
    features: boot.features[current] ?? {},
    emit: emitFor(appOf(current)),
    pending: [...pending],
    canGoBack: history.length > 0,
    back,
    remember,
    refresh,
    contexts,
    runtime,
  });

  // Listen before connecting: hosts may deliver the opening result as soon as the handshake ends.
  bridge.onResult((result) => {
    // The host opened the view (or pushed new data): what it reports as the call's arguments is the refresh input.
    if (result.view && moduleOf(result.view.view) && bridge.toolInput) sourceInput = { value: bridge.toolInput() };
    apply(result);
  });
  bridge.onHostContext((host) => {
    state.host = host;
    applyTheme(host);
    update();
  });
  await bridge.connect();
  state.host = bridge.host();
  applyTheme(state.host);

  mounted = rootModule.mount(element, rootProps());
  return {
    props: () => rootProps(),
    unmount: () => {
      mounted?.unmount();
      mounted = undefined;
    },
  };
}
