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

/**
 * Starts a view bundle: connects to the host, mounts the root view, and re-renders it when the host delivers new
 * data or context. Results of the root view's bound operations, whether the host pushes them or the view calls
 * them itself, replace its data.
 */
export async function startView(options: StartOptions): Promise<StartedView> {
  const boot = options.boot ?? readBoot();
  const bridge = options.bridge ?? (boot.channel === "preview" ? createPreviewBridge(boot) : createMcpBridge());
  const root = options.views[boot.view];
  if (!root) throw new Error(`The bundle has no module for view ${boot.view}.`);
  // The root renders prompts for itself and everything embedded in it, so its calls can ask inside the view.
  const viewCall = root.handlesPrompts === true && boot.viewCallTool ? { viewCall: boot.viewCallTool } : {};

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
      }
    }
    mounted?.update(rootProps());
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
              mounted?.update(rootProps());
              resolve(answer);
            },
          };
          mounted?.update(rootProps());
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

  const emitFor = (app: string): ViewEmit => ({
    async call<T>(operation: string, input: unknown = {}) {
      const route = boot.operations[`${app}.${operation}`];
      if (!route) {
        throw new ViewCallError("unreachable", `${app}.${operation} is not served where this view runs.`);
      }
      let result = await bridge.call(route.tool, input, { app, operation, ...viewCall });
      for (let round = 1; result.input; round++) {
        if (round > MAX_ROUNDS) throw new ViewCallError("internal", `${app}.${operation} kept asking for input.`);
        const resume = await answerAll(result.input);
        result = await bridge.call(route.tool, input, { app, operation, resume, ...viewCall });
      }
      if (result.error) throw result.error;
      if (result.view?.view === boot.view) apply(result);
      return result.data as T;
    },
    openLink: (url) => bridge.openLink(url),
  });

  const runtime: ViewRuntime = {
    views: options.views,
    childProps: (view, data, contexts) => ({
      view,
      data,
      features: boot.features[view] ?? {},
      host: state.host,
      emit: emitFor(appOf(view)),
      contexts,
      runtime,
    }),
  };

  const rootEmit = emitFor(appOf(boot.view));
  const rootProps = (contexts: ContextScope = emptyScope): ViewProps => ({
    ...state,
    view: boot.view,
    features: boot.features[boot.view] ?? {},
    emit: rootEmit,
    contexts,
    runtime,
  });

  // Listen before connecting: hosts may deliver the opening result as soon as the handshake ends.
  bridge.onResult(apply);
  bridge.onHostContext((host) => {
    state.host = host;
    applyTheme(host);
    mounted?.update(rootProps());
  });
  await bridge.connect();
  state.host = bridge.host();
  applyTheme(state.host);

  const element = options.element ?? document.getElementById(ROOT_ELEMENT_ID) ?? document.body;
  mounted = root.mount(element, rootProps());
  return {
    props: () => rootProps(),
    unmount: () => {
      mounted?.unmount();
      mounted = undefined;
    },
  };
}
