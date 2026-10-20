// @vitest-environment happy-dom
import type { ViewBoot } from "@syrinx/core";
import { defineViewContext, startView, type BridgeResult, type HostBridge, type ViewModule } from "@syrinx/ui";
import { describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { Embed, toView, useView, useViewContext, ViewContext, ViewPart } from "./index.js";

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
