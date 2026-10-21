// @vitest-environment happy-dom
import type { ViewBoot } from "@syrinx/core";
import {
  defineViewContext,
  startView,
  type BridgeResult,
  type HostBridge,
  type HostContext,
  type ViewModule,
  ViewCallError,
} from "@syrinx/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import {
  Embed,
  mountVueView,
  toView,
  useView,
  useViewAction,
  useViewContext,
  useViewPoll,
  ViewAction,
  ViewContainer,
  ViewContext,
  ViewFrame,
  ViewPart,
  ViewPending,
  ViewSkeleton,
} from "./index.js";

interface Payload {
  items: { id: string; customer: string }[];
}
const selection = defineViewContext<{ id: string | undefined }, Payload>({
  name: "selection",
  initial: (p) => ({ id: p?.items[0]?.id }),
});

const List = defineComponent(() => {
  const view = useView<Payload>();
  const [, setSel] = useViewContext(selection);
  return () =>
    h(
      "ul",
      (view.value.data?.items ?? []).map((i) =>
        h(
          "li",
          h(
            "button",
            {
              "data-id": i.id,
              onClick: () => {
                setSel({ id: i.id });
              },
            },
            i.id,
          ),
        ),
      ),
    );
});

const Detail = defineComponent(() => {
  const view = useView<Payload>();
  const [sel] = useViewContext(selection);
  return () => {
    const item = view.value.data?.items.find((i) => i.id === sel.value.id);
    return h("section", { class: "detail" }, [
      h("h2", item?.id ?? "none"),
      item && h(Embed, { view: "customers/badge", data: { name: item.customer } }),
      h(Embed, { view: "legacy/chip" }),
    ]);
  };
});

const Browser = defineComponent(() => {
  const view = useView<Payload>();
  return () =>
    h(ViewContext, { context: selection, payload: view.value.data }, () => [
      h(ViewPart, { name: "list" }, () => h(List)),
      h(ViewPart, { name: "detail" }, () => h(Detail)),
    ]);
});

/** An embedded Vue view from another app: own features, and it calls its own app. */
const Badge = defineComponent(() => {
  const view = useView<{ name: string }>();
  const [sel] = useViewContext(selection);
  return () =>
    h("span", { class: "badge", "data-compact": String(view.value.features.compact) }, [
      `${view.value.data?.name ?? "?"} (${sel.value.id ?? "-"})`,
    ]);
});

/** A view built without Vue: it binds to the same context through the scope in its props. */
const chip: ViewModule = {
  mount(el, props) {
    const store = props.contexts.find(selection);
    const render = () => (el.textContent = `chip:${store?.get().id ?? "none"}`);
    render();
    const stop = store?.subscribe(render);
    return { update: render, unmount: () => stop?.() };
  },
};

function must<T extends Element>(found: T | null): T {
  if (!found) throw new Error("element not found");
  return found;
}

const boot: ViewBoot = {
  view: "invoices/browser",
  channel: "mcp",
  operations: {},
  features: { "invoices/browser": {}, "customers/badge": { compact: true } },
};

function bridge() {
  let push: (r: BridgeResult) => void = () => undefined;
  const b: HostBridge = {
    connect: () => Promise.resolve(),
    host: () => ({}),
    onHostContext: () => undefined,
    onResult: (l) => (push = l),
    call: () => Promise.resolve({ data: {} }),
    openLink: () => Promise.resolve(),
  };
  return {
    b,
    push: (r: BridgeResult) => {
      push(r);
    },
  };
}

const data: Payload = {
  items: [
    { id: "inv_1", customer: "Acme" },
    { id: "inv_2", customer: "Globex" },
  ],
};

async function start() {
  document.body.innerHTML = `<div id="root"></div>`;
  const { b, push } = bridge();
  const element = must(document.querySelector<HTMLElement>("#root"));
  const views = { "invoices/browser": toView(Browser), "customers/badge": toView(Badge), "legacy/chip": chip };
  await startView({ views, boot, bridge: b, element });
  return { element, push };
}

describe("Vue views", () => {
  it("shares view context across parts, Vue embeds and non-Vue embeds", async () => {
    const { element, push } = await start();
    push({ data, view: { view: "invoices/browser", op: "list", schemaVersion: "" } });
    await nextTick();
    expect(element.querySelector(".detail h2")?.textContent).toBe("inv_1");
    expect(element.querySelector(".badge")?.textContent).toBe("Acme (inv_1)");
    expect(element.querySelector(".badge")?.getAttribute("data-compact")).toBe("true");
    expect(element.querySelector("[data-syrinx-embed='legacy/chip']")?.textContent).toBe("chip:inv_1");

    must(element.querySelector<HTMLButtonElement>("button[data-id='inv_2']")).click();
    await nextTick();
    expect(element.querySelector(".detail h2")?.textContent).toBe("inv_2");
    expect(element.querySelector(".badge")?.textContent).toBe("Globex (inv_2)");
    expect(element.querySelector("[data-syrinx-embed='legacy/chip']")?.textContent).toBe("chip:inv_2");
  });

  it("keeps the selection when data refreshes, and shows only the selected part", async () => {
    const { element, push } = await start();
    push({ data, view: { view: "invoices/browser", op: "list", schemaVersion: "" } });
    await nextTick();
    must(element.querySelector<HTMLButtonElement>("button[data-id='inv_2']")).click();
    push({ data: { items: [...data.items] }, view: { view: "invoices/browser", op: "list", schemaVersion: "" } });
    await nextTick();
    expect(element.querySelector(".detail h2")?.textContent).toBe("inv_2");

    push({ data, view: { view: "invoices/browser", op: "get", component: "detail", schemaVersion: "" } });
    await nextTick();
    expect(element.querySelector("ul")).toBeNull();
    expect(element.querySelector(".detail")).not.toBeNull();
  });

  it("renders a default dialog for questions and answers with the user's choice", async () => {
    document.body.innerHTML = `<div id="q"></div>`;
    const element = must(document.querySelector<HTMLElement>("#q"));
    const { b } = bridge();
    let round = 0;
    b.call = (_tool, _input, { resume }) =>
      Promise.resolve(
        round++ === 0
          ? { input: { requests: { c: { message: "Void inv_1?", fields: {} } }, requestState: "s" } }
          : { data: { answered: resume?.inputResponses.c?.action } },
      );
    let mounts = 0;
    const Plain = defineComponent(() => {
      mounts++;
      return () => h("p", "plain");
    });
    const started = await startView({
      views: { "invoices/browser": toView(Plain) },
      boot: { ...boot, operations: { "invoices.void": { tool: "void" } } },
      bridge: b,
      element,
    });
    const pending = started.props().emit.call("void", { id: "inv_1" });
    await vi.waitFor(() => {
      expect(element.querySelector("[role=dialog]")?.textContent).toContain("Void inv_1?");
    });
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>("[role=dialog] button"));
    buttons.find((x) => x.textContent === "Decline")?.click();
    await expect(pending).resolves.toEqual({ answered: "decline" });
    await nextTick();
    expect(element.querySelector("[role=dialog]")).toBeNull();
    expect(mounts).toBe(1); // opening and closing the dialog kept the view's state
  });

  it("explains embeds missing from the bundle, and useView outside a view", async () => {
    const Lonely = defineComponent(() => () => h(Embed, { view: "nope/missing" }));
    document.body.innerHTML = `<div id="r"></div>`;
    const element = must(document.querySelector<HTMLElement>("#r"));
    await startView({ views: { "invoices/browser": toView(Lonely) }, boot, bridge: bridge().b, element });
    expect(element.textContent).toMatch(/not in this bundle/);
    expect(() => useView()).toThrow(/inside a Syrinx view/);
  });
});

describe("ViewFrame", () => {
  const Framed = defineComponent(() => () => h(ViewFrame, null, () => h("p", { class: "content" }, "inside")));

  async function frameStyle(host: HostContext, props?: { maxHeight?: number; natural?: boolean }) {
    document.body.innerHTML = `<div id="root"></div>`;
    const element = must(document.querySelector<HTMLElement>("#root"));
    const framed = props ? defineComponent(() => () => h(ViewFrame, props, () => h("p", "x"))) : Framed;
    const b: HostBridge = {
      connect: () => Promise.resolve(),
      host: () => host,
      onHostContext: () => undefined,
      onResult: () => undefined,
      call: () => Promise.resolve({ data: {} }),
      openLink: () => Promise.resolve(),
    };
    await startView({ views: { "invoices/browser": toView(framed) }, boot, bridge: b, element });
    await nextTick();
    return must(element.querySelector<HTMLElement>(".syrinx-frame"));
  }

  it("caps and scrolls at 640px by default, lower when the host's limit is, and not at all fullscreen", async () => {
    const byDefault = await frameStyle({ displayMode: "inline" });
    expect(byDefault.style.maxHeight).toBe("640px");
    expect(byDefault.style.overflowY).toBe("auto");
    // A scroll at the end of the view must reach the chat behind it, not be swallowed.
    expect(byDefault.style.overscrollBehavior).not.toBe("contain");
    expect(byDefault.querySelector(".content")?.textContent).toBe("inside");

    expect((await frameStyle({ containerDimensions: { maxHeight: 480 } })).style.maxHeight).toBe("480px");
    // A host's higher limit does not lift the cap, and the cap is there for content to size by.
    const roomy = await frameStyle({ containerDimensions: { maxHeight: 1600 } });
    expect(roomy.style.maxHeight).toBe("640px");
    expect(roomy.style.getPropertyValue("--frame-max-height")).toBe("640px");
    expect((await frameStyle({}, { maxHeight: 300 })).style.maxHeight).toBe("300px");

    const fullscreen = await frameStyle({ displayMode: "fullscreen", containerDimensions: { maxHeight: 480 } });
    expect(fullscreen.style.maxHeight).toBe("");
    expect(fullscreen.style.overflowY).toBe("");
  });

  it("pads a fullscreen frame by the host's safe-area insets, with a fallback for a mobile host that sends none", async () => {
    const reported = await frameStyle({
      displayMode: "fullscreen",
      platform: "mobile",
      safeAreaInsets: { top: 64, right: 0, bottom: 90, left: 0 },
    });
    expect(reported.style.getPropertyValue("--syrinx-inset-top")).toBe("64px");
    expect(reported.style.getPropertyValue("--syrinx-inset-bottom")).toBe("90px");

    const fallback = await frameStyle({ displayMode: "fullscreen", platform: "mobile" });
    expect(fallback.style.getPropertyValue("--syrinx-inset-top")).toBe("56px");
    expect(fallback.style.getPropertyValue("--syrinx-inset-bottom")).toBe("88px");

    // Nothing to pad on a desktop host that sends nothing, or inline, where the host draws its own chrome around the frame.
    expect(
      (await frameStyle({ displayMode: "fullscreen", platform: "desktop" })).style.getPropertyValue(
        "--syrinx-inset-top",
      ),
    ).toBe("");
    expect(
      (await frameStyle({ displayMode: "inline", platform: "mobile" })).style.getPropertyValue("--syrinx-inset-top"),
    ).toBe("");
  });

  it("does not cap on a mobile host or when the view asks for its natural height, so the chat is the only thing that scrolls", async () => {
    expect((await frameStyle({ displayMode: "inline", platform: "mobile" })).style.maxHeight).toBe("");
    const natural = await frameStyle({ displayMode: "inline", platform: "desktop" }, { natural: true });
    expect(natural.style.maxHeight).toBe("");
    expect(natural.style.overflowY).toBe("");
  });
});

/** Runs a composable inside a component, as a template would, and hands back what it returned. */
function inComponent<T>(setup: () => T) {
  let result: T | undefined;
  const app = createApp(
    defineComponent(() => {
      result = setup();
      return () => h("div");
    }),
  );
  app.mount(document.createElement("div"));
  return {
    result: result as T,
    unmount: () => {
      app.unmount();
    },
  };
}

describe("useViewAction", () => {
  it("tracks a running action, keeps its failure instead of throwing, and clears it on the next run", async () => {
    let release: (value: string) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const { result: action } = inComponent(() =>
      useViewAction(
        (mode: "ok" | "fail") =>
          new Promise<string>((resolve, reject) => {
            release = resolve;
            fail = reject;
            expect(["ok", "fail"]).toContain(mode);
          }),
      ),
    );
    const first = action.run("ok");
    expect(action.pending.value).toBe(true);
    release("done");
    await expect(first).resolves.toBe("done");
    expect(action.pending.value).toBe(false);
    expect(action.error.value).toBeUndefined();

    const second = action.run("fail");
    fail(new ViewCallError("forbidden", "Not allowed."));
    await expect(second).resolves.toBeUndefined();
    expect(action.error.value).toMatchObject({ kind: "forbidden", message: "Not allowed." });

    const third = action.run("ok");
    expect(action.error.value).toBeUndefined();
    release("again");
    await third;

    const fourth = action.run("fail");
    fail(new Error("boom"));
    await fourth;
    expect(action.error.value).toMatchObject({ kind: "internal", message: "boom" });
  });
});

describe("useViewPoll", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls until the result says it is done, backing off as told, and stops there", async () => {
    vi.useFakeTimers();
    const statuses = ["pending", "running", "complete", "never"];
    const poll = vi.fn(() => Promise.resolve({ status: statuses[poll.mock.calls.length - 1] }));
    const waits: number[] = [];
    const { result } = inComponent(() =>
      useViewPoll(poll, {
        until: (job) => job.status === "complete",
        interval: (attempt) => (waits.push(attempt), 100 * attempt),
      }),
    );
    result.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(result.polling.value).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(result.data.value).toEqual({ status: "complete" });
    expect(result.polling.value).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([1, 2]);
  });

  it("stops on a failure and keeps it, stops when the component goes, and caps the attempts", async () => {
    vi.useFakeTimers();
    const failing = vi.fn(() => Promise.reject(new ViewCallError("not_found", "Gone.")));
    const a = inComponent(() => useViewPoll(failing, { interval: 10 }));
    a.result.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(a.result.error.value).toMatchObject({ kind: "not_found" });
    expect(a.result.polling.value).toBe(false);

    const steady = vi.fn(() => Promise.resolve(1));
    const b = inComponent(() => useViewPoll(steady, { interval: 10 }));
    b.result.start();
    await vi.advanceTimersByTimeAsync(25);
    const seen = steady.mock.calls.length;
    b.unmount();
    await vi.advanceTimersByTimeAsync(500);
    expect(steady.mock.calls.length).toBe(seen);

    const capped = vi.fn(() => Promise.resolve(1));
    const c = inComponent(() => useViewPoll(capped, { interval: 1, maxAttempts: 3 }));
    c.result.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(capped).toHaveBeenCalledTimes(3);
    expect(c.result.polling.value).toBe(false);
  });

  it("waits the first interval before polling when asked not to poll straight away", async () => {
    vi.useFakeTimers();
    const poll = vi.fn(() => Promise.resolve(1));
    const { result } = inComponent(() => useViewPoll(poll, { interval: 50, immediate: false, until: () => true }));
    result.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});

describe("loading components", () => {
  it("draws skeleton rows with a status role, in the sizes asked for", async () => {
    document.body.innerHTML = `<div id="root"></div>`;
    createApp({
      render: () => h(ViewSkeleton, { rows: 4, height: 12, widths: [100, 50], label: "Loading exports" }),
    }).mount("#root");
    await nextTick();
    const status = must(document.querySelector<HTMLElement>("[role=status]"));
    expect(status.getAttribute("aria-label")).toBe("Loading exports");
    const rows = Array.from(status.querySelectorAll<HTMLElement>(".syrinx-skeleton-row"));
    expect(rows.map((r) => r.style.width)).toEqual(["100%", "50%", "100%", "50%"]);
    expect(rows[0]?.style.height).toBe("12px");
    expect(document.getElementById("syrinx-ui-vue-styles")).not.toBeNull();
  });

  it("covers its content while one of the view's calls is in flight, and only for the calls it is told about", async () => {
    document.body.innerHTML = `<div id="root"></div>`;
    let release: (result: BridgeResult) => void = () => undefined;
    const b: HostBridge = {
      connect: () => Promise.resolve(),
      host: () => ({}),
      onHostContext: () => undefined,
      onResult: () => undefined,
      call: () => new Promise<BridgeResult>((resolve) => (release = resolve)),
      openLink: () => Promise.resolve(),
    };
    const View = defineComponent(
      () => () =>
        h(ViewPending, { ops: ["new"], label: "Opening export…" }, () => h("p", { class: "inner" }, "content")),
    );
    const started = await startView({
      views: { "invoices/browser": toView(View) },
      boot: { ...boot, operations: { "invoices.new": { tool: "n" }, "invoices.other": { tool: "o" } } },
      bridge: b,
      element: must(document.querySelector<HTMLElement>("#root")),
    });
    await nextTick();
    expect(document.querySelector("[role=status]")).toBeNull();

    const other = started.props().emit.call("other");
    await nextTick();
    expect(document.querySelector("[role=status]")).toBeNull();
    release({ data: {} });
    await other;

    const opening = started.props().emit.call("new");
    await nextTick();
    expect(document.querySelector("[role=status]")?.textContent).toContain("Opening export…");
    expect(document.querySelector(".inner")?.textContent).toBe("content");
    release({ data: {} });
    await opening;
    await nextTick();
    expect(document.querySelector("[role=status]")).toBeNull();
  });
});

describe("mountVueView", () => {
  it("mounts a view over REST in one call, and opens it on an operation", async () => {
    document.body.innerHTML = `<div id="root"></div>`;
    const requests: { url: string; body: unknown }[] = [];
    const fetchFn = ((url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(init.body as string) });
      return Promise.resolve(
        new Response(JSON.stringify({ resultType: "complete", data: { items: [{ id: "inv_1" }] } }), { status: 200 }),
      );
    }) as typeof fetch;
    const View = defineComponent(() => {
      const view = useView<{ items: { id: string }[] }>();
      return () =>
        h(
          "ul",
          (view.value.data?.items ?? []).map((i) => h("li", i.id)),
        );
    });
    const mounted = await mountVueView({
      view: "invoices/browser",
      component: View,
      element: must(document.querySelector<HTMLElement>("#root")),
      base: "/api/invoices/ops",
      bound: { list: undefined },
      operations: ["list"],
      fetch: fetchFn,
      host: { theme: "light", displayMode: "fullscreen" },
    });
    await mounted.show("list", { status: "open" });
    await nextTick();
    expect(requests).toEqual([{ url: "/api/invoices/ops/list", body: { status: "open" } }]);
    expect(document.querySelector("#root li")?.textContent).toBe("inv_1");
    mounted.unmount();
    await nextTick();
    expect(document.querySelector("#root li")).toBeNull();
  });
});

describe("ViewContainer and ViewAction", () => {
  /** Mounts a container around a custom Export action, in a host with the given context. */
  async function mountContainer(
    host: HostContext,
    props: Record<string, unknown> = {},
    calls: { selected: number; links: string[]; modes: string[]; tools?: { tool: string; input: unknown }[] } = {
      selected: 0,
      links: [],
      modes: [],
    },
  ) {
    document.body.innerHTML = `<div id="root"></div>`;
    const element = must(document.querySelector<HTMLElement>("#root"));
    const Body = defineComponent(
      () => () =>
        h(ViewContainer, { title: "Contacts", ...props }, () => [
          h(
            ViewAction,
            { label: "Export", onSelect: () => (calls.selected += 1) },
            {
              default: ({ run }: { run: () => void }) =>
                h("button", { class: "custom-export", onClick: run }, "Export…"),
            },
          ),
          h("p", { class: "content" }, "inside"),
        ]),
    );
    const b: HostBridge = {
      connect: () => Promise.resolve(),
      host: () => host,
      onHostContext: () => undefined,
      onResult: () => undefined,
      call: (tool, input) => {
        calls.tools?.push({ tool, input });
        return Promise.resolve({ data: {} });
      },
      openLink: (url) => {
        calls.links.push(url);
        return Promise.resolve();
      },
      requestDisplayMode: (mode) => {
        calls.modes.push(mode);
        return Promise.resolve(mode);
      },
    };
    const routes = { "invoices.list": { tool: "invoices_list" }, "customers.get": { tool: "customers_get" } };
    await startView({
      views: { "invoices/browser": toView(Body) },
      boot: { ...boot, operations: routes },
      bridge: b,
      element,
    });
    await nextTick();
    const q = (selector: string) => element.querySelector<HTMLElement>(selector);
    const texts = (selector: string) => Array.from(element.querySelectorAll(selector), (e) => e.textContent.trim());
    return { q, texts, calls, element };
  }

  type Mounted = Awaited<ReturnType<typeof mountContainer>>;
  /** Clicks the nth menu item and lets the view settle. */
  const choose = async (c: Mounted, index: number) => {
    must(c.element.querySelectorAll<HTMLElement>("[role=menuitem]")[index] ?? null).click();
    await nextTick();
  };
  const menu = async (c: Mounted) => {
    must(c.q("[aria-haspopup=menu]")).click();
    await nextTick();
  };

  it("on a web page draws no bar and leaves the action where the view put it, wired to select", async () => {
    const c = await mountContainer({ platform: "web", displayMode: "fullscreen" });
    expect(c.q(".syrinx-container-bar")).toBeNull();
    expect(c.q(".content")?.textContent).toBe("inside");
    must(c.q(".custom-export")).click();
    expect(c.calls.selected).toBe(1);
  });

  it("in a host shows the bar and moves the action into its menu, with Open in browser after it", async () => {
    const c = await mountContainer(
      { platform: "desktop" },
      { openInBrowser: "https://app.example/contacts?search=a" },
    );
    expect(c.q(".syrinx-container-title")?.textContent).toBe("Contacts");
    expect(c.q(".custom-export")).toBeNull();
    await menu(c);
    expect(c.texts("[role=menuitem]")).toEqual(["Export", "Open in browser"]);

    await choose(c, 0);
    expect(c.calls.selected).toBe(1);
    expect(c.q("[role=menu]")).toBeNull();

    await menu(c);
    await choose(c, 1);
    expect(c.calls.links).toEqual(["https://app.example/contacts?search=a"]);
  });

  it("offers Open in browser only when the view gives a link, and takes a function that makes it when asked", async () => {
    const without = await mountContainer({ platform: "desktop" });
    await menu(without);
    expect(without.texts("[role=menuitem]")).toEqual(["Export"]);

    const made = await mountContainer({ platform: "desktop" }, { openInBrowser: () => "https://app.example/now" });
    await menu(made);
    await choose(made, 1);
    expect(made.calls.links).toEqual(["https://app.example/now"]);
  });

  it("shows Expand where the host offers fullscreen and Collapse once it is there, and nothing where it does not", async () => {
    const inline = await mountContainer({
      platform: "mobile",
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
    });
    expect(inline.texts(".syrinx-container-btn")).toContain("Expand");
    must(inline.element.querySelector<HTMLElement>(".syrinx-container-btn") ?? null).click();
    await nextTick();
    expect(inline.calls.modes).toEqual(["fullscreen"]);

    const full = await mountContainer({
      platform: "mobile",
      displayMode: "fullscreen",
      availableDisplayModes: ["inline", "fullscreen"],
    });
    expect(full.texts(".syrinx-container-btn")).toContain("Collapse");
    expect(full.texts(".syrinx-container-btn")).not.toContain("Expand");

    const none = await mountContainer({ platform: "mobile", displayMode: "inline" });
    expect(none.texts(".syrinx-container-btn")).not.toContain("Expand");
  });

  it("turns the title into a dropdown of top-level places, marks the current one and calls the chosen one's operation", async () => {
    const navigation = [
      { id: "invoices", label: "Invoices", op: "list" },
      { id: "customers", label: "Customers", op: "customers.get", input: { id: "c_1" } },
    ];
    const tools: { tool: string; input: unknown }[] = [];
    const c = await mountContainer(
      { platform: "desktop" },
      { navigation, current: "invoices", title: "ignored when the current item has a label" },
      { selected: 0, links: [], modes: [], tools },
    );
    expect(c.q(".syrinx-container-navbtn")?.textContent).toContain("Invoices");
    must(c.q(".syrinx-container-navbtn")).click();
    await nextTick();
    expect(c.texts("[role=menuitemradio]")).toEqual(["Invoices", "Customers"]);
    expect(c.q("[aria-checked=true]")?.textContent).toContain("Invoices");

    // The current place does nothing; another calls its operation with its input.
    must(c.element.querySelectorAll<HTMLElement>("[role=menuitemradio]")[0] ?? null).click();
    await nextTick();
    expect(tools).toEqual([]);
    must(c.q(".syrinx-container-navbtn")).click();
    await nextTick();
    must(c.element.querySelectorAll<HTMLElement>("[role=menuitemradio]")[1] ?? null).click();
    await nextTick();
    expect(tools).toEqual([{ tool: "customers_get", input: { id: "c_1" } }]);
    expect(c.q("[role=menu]")).toBeNull();

    // A single place is only a title.
    const single = await mountContainer(
      { platform: "desktop" },
      { navigation: navigation.slice(0, 1), current: "invoices" },
    );
    expect(single.q(".syrinx-container-navbtn")).toBeNull();
  });

  it("lists a section's sub-sections under it, says where you are as Section › Sub-section, and goes to either", async () => {
    const navigation = [
      { id: "invoices", label: "Invoices", op: "list" },
      {
        id: "customers",
        label: "Customers",
        op: "customers.get",
        input: { id: "all" },
        children: [
          { id: "customers-open", label: "Open", op: "customers.get", input: { id: "open" } },
          { id: "customers-paid", label: "Paid", op: "customers.get", input: { id: "paid" } },
        ],
      },
    ];
    const tools: { tool: string; input: unknown }[] = [];
    const c = await mountContainer(
      { platform: "desktop" },
      { navigation, current: "customers-open" },
      { selected: 0, links: [], modes: [], tools },
    );
    expect(c.q(".syrinx-container-navbtn")?.textContent).toContain("Customers › Open");
    must(c.q(".syrinx-container-navbtn")).click();
    await nextTick();
    expect(c.texts("[role=menuitemradio]")).toEqual(["Invoices", "Customers", "Open", "Paid"]);
    expect(c.element.querySelectorAll(".syrinx-container-subitem")).toHaveLength(2);
    // Only the exact place is checked; its section is marked as holding it.
    expect(c.texts("[aria-checked=true]")).toEqual(["Open"]);
    expect(c.q(".syrinx-container-parent-active")?.textContent).toContain("Customers");

    must(c.element.querySelectorAll<HTMLElement>("[role=menuitemradio]")[3] ?? null).click();
    await nextTick();
    expect(tools).toEqual([{ tool: "customers_get", input: { id: "paid" } }]);

    // A lone section with sub-sections still has somewhere to go.
    const lone = await mountContainer(
      { platform: "desktop" },
      { navigation: navigation.slice(1, 2), current: "customers" },
    );
    expect(lone.q(".syrinx-container-navbtn")?.textContent).toContain("Customers");
  });

  it("leaves the top inset to the sticky bar, so scrolled content cannot show in a strip above it", async () => {
    const c = await mountContainer({ platform: "mobile", displayMode: "fullscreen" });
    const frame = must(c.q(".syrinx-frame"));
    // The frame does not pad the top (that strip would be see-through when the bar sticks); the bar pads itself by the inset.
    expect(frame.style.paddingTop).toBe("");
    expect(frame.style.getPropertyValue("--syrinx-inset-top")).toBe("56px");
    expect(frame.style.getPropertyValue("--syrinx-inset-bottom")).toBe("88px");
  });

  it("closes the menu on Escape, and chrome=always or never overrides the host", async () => {
    const c = await mountContainer({ platform: "desktop" });
    await menu(c);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(c.q("[role=menu]")).toBeNull();

    expect((await mountContainer({ platform: "desktop" }, { chrome: "never" })).q(".syrinx-container-bar")).toBeNull();
    const forced = await mountContainer({ platform: "web" }, { chrome: "always" });
    expect(forced.q(".syrinx-container-bar")).not.toBeNull();
    expect(forced.q(".custom-export")).toBeNull();
  });
});
