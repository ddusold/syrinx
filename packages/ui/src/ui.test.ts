// @vitest-environment happy-dom
import * as mcp from "@syrinx/mcp";
import type { ViewBoot } from "@syrinx/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createContextStore,
  defineViewContext,
  emptyScope,
  fromToolResult,
  startView,
  ViewCallError,
  type BridgeResult,
  type HostBridge,
  type HostContext,
  type ViewModule,
  type ViewProps,
} from "./index.js";
import { ERROR_META_KEY, META_PREFIX, SURFACE_META_KEY, VIEW_META_KEY } from "./mcp.js";

const selection = defineViewContext<{ selected?: string | undefined; seen: number }, { items: string[] }>({
  name: "selection",
  schema: z.object({ selected: z.string().optional(), seen: z.number() }),
  initial: (payload) => ({ ...(payload?.items[0] ? { selected: payload.items[0] } : {}), seen: 0 }),
  merge: (current, payload) => ({ ...current, seen: payload.items.length }),
});

describe("view context", () => {
  it("seeds, validates, notifies and merges", () => {
    const store = createContextStore(selection, { items: ["a", "b"] });
    expect(store.get()).toEqual({ selected: "a", seen: 0 });
    const seen: unknown[] = [];
    const stop = store.subscribe((s) => seen.push(s));
    store.set((s) => ({ ...s, selected: "b" }));
    store.refresh({ items: ["a", "b", "c"] });
    expect(store.get()).toEqual({ selected: "b", seen: 3 });
    expect(() => {
      store.set({ seen: "many" } as never);
    }).toThrow(/rejected a value/);
    stop();
    store.set({ seen: 9 });
    expect(seen).toHaveLength(2);
  });

  it("seeds from the first data when it arrives after the store was created", () => {
    const store = createContextStore(selection, undefined);
    expect(store.get()).toEqual({ seen: 0 });
    store.refresh({ items: ["q"] });
    expect(store.get()).toEqual({ selected: "q", seen: 0 });
    store.refresh({ items: ["q", "r"] });
    expect(store.get()).toEqual({ selected: "q", seen: 2 });
  });

  it("keeps state on refresh without a merge rule", () => {
    const plain = defineViewContext({ name: "plain", initial: () => ({ n: 1 }) });
    const store = createContextStore(plain, { first: true });
    store.set({ n: 2 });
    store.refresh({ anything: true });
    expect(store.get()).toEqual({ n: 2 });
  });

  it("finds the nearest provider by name, without leaking to siblings", () => {
    const outer = createContextStore(selection, { items: ["x"] });
    const inner = createContextStore(selection, { items: ["y"] });
    const a = emptyScope.with(outer);
    const b = a.with(inner);
    expect(b.find(selection)?.get().selected).toBe("y");
    expect(a.find(selection)?.get().selected).toBe("x");
    expect(emptyScope.find(selection)).toBeUndefined();
  });
});

describe("tool results", () => {
  it("uses the same _meta keys as @syrinx/mcp", () => {
    expect([META_PREFIX, ERROR_META_KEY, VIEW_META_KEY, SURFACE_META_KEY]).toEqual([
      mcp.META_PREFIX,
      mcp.ERROR_META_KEY,
      mcp.VIEW_META_KEY,
      mcp.SURFACE_META_KEY,
    ]);
  });

  it("reads data, view metadata and errors", () => {
    const view = { view: "a/b", op: "get", schemaVersion: "v1" };
    expect(fromToolResult({ structuredContent: { id: 1 }, _meta: { [VIEW_META_KEY]: view } })).toEqual({
      data: { id: 1 },
      view,
    });
    expect(fromToolResult({ content: [{ type: "text", text: "[1,2]" }] }).data).toEqual([1, 2]);
    const failed = fromToolResult({
      isError: true,
      content: [{ type: "text", text: "not_found: gone" }],
      _meta: { [ERROR_META_KEY]: { kind: "not_found", message: "gone", issues: [] } },
    });
    expect(failed.error).toBeInstanceOf(ViewCallError);
    expect(failed.error).toMatchObject({ kind: "not_found", message: "gone" });
  });
});

/** A bridge driven by the test: push results and host changes, answer calls from a table. */
function fakeBridge(answers: Record<string, BridgeResult> = {}) {
  let pushResult: (r: BridgeResult) => void = () => undefined;
  let pushHost: (h: HostContext) => void = () => undefined;
  const calls: { tool: string; input: unknown }[] = [];
  const bridge: HostBridge = {
    connect: () => Promise.resolve(),
    host: () => ({ theme: "dark" }),
    onHostContext: (l) => (pushHost = l),
    onResult: (l) => (pushResult = l),
    call: (tool, input) => {
      calls.push({ tool, input });
      return Promise.resolve(answers[tool] ?? { data: { echoed: input } });
    },
    openLink: () => Promise.resolve(),
  };
  return {
    bridge,
    calls,
    push: (r: BridgeResult) => {
      pushResult(r);
    },
    host: (h: HostContext) => {
      pushHost(h);
    },
  };
}

/** Records every props object it renders with. */
function recorder() {
  const renders: ViewProps[] = [];
  const module: ViewModule = {
    mount: (_el, props) => {
      renders.push(props);
      return { update: (p) => renders.push(p), unmount: () => undefined };
    },
  };
  return { module, renders, last: () => renders.at(-1) };
}

const boot: ViewBoot = {
  view: "invoices/browser",
  channel: "mcp",
  operations: {
    "invoices.list": { tool: "invoices_list", schemaVersion: "v1" },
    "invoices.send": { tool: "invoices_send" },
    "customers.get": { tool: "customers_get" },
  },
  features: { "invoices/browser": { actions: true }, "customers/badge": { compact: true } },
};

describe("startView", () => {
  it("mounts the root with host context and re-renders on pushed results and host changes", async () => {
    const { bridge, push, host } = fakeBridge();
    const root = recorder();
    await startView({ views: { "invoices/browser": root.module }, boot, bridge, element: document.body });
    expect(root.last()).toMatchObject({ view: "invoices/browser", data: undefined, features: { actions: true } });
    expect(root.last()?.host).toEqual({ theme: "dark" });
    expect(document.documentElement.dataset.theme).toBe("dark");

    push({
      data: { items: [] },
      view: { view: "invoices/browser", op: "get", component: "detail", schemaVersion: "x" },
    });
    expect(root.last()).toMatchObject({ data: { items: [] }, component: "detail", source: { op: "get" } });
    push({ error: new ViewCallError("forbidden", "no") });
    expect(root.last()?.error?.kind).toBe("forbidden");
    host({ theme: "light" });
    expect(root.last()?.host.theme).toBe("light");
  });

  it("routes calls by app to the endpoint's tool names and refreshes on bound results", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fresh = { data: { items: [1] }, view: { view: "invoices/browser", op: "list", schemaVersion: "v2" } };
    const { bridge, calls } = fakeBridge({
      invoices_list: fresh,
      invoices_send: { error: new ViewCallError("conflict", "sent") },
    });
    const root = recorder();
    const started = await startView({
      views: { "invoices/browser": root.module },
      boot,
      bridge,
      element: document.body,
    });
    const { emit, runtime } = started.props();

    await expect(emit.call("list")).resolves.toEqual({ items: [1] });
    expect(root.last()?.data).toEqual({ items: [1] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("another version"));
    await expect(emit.call("send", { id: "inv_1" })).rejects.toMatchObject({ kind: "conflict" });
    await expect(emit.call("purge")).rejects.toMatchObject({ kind: "unreachable" });

    const child = runtime.childProps("customers/badge", { name: "Acme" }, emptyScope);
    expect(child).toMatchObject({ view: "customers/badge", data: { name: "Acme" }, features: { compact: true } });
    await child.emit.call("get", { name: "Acme" });
    expect(calls.map((c) => c.tool)).toEqual(["invoices_list", "invoices_send", "customers_get"]);
    warn.mockRestore();
  });

  it("asks the user through props when a host relays input_required, then retries with the answer", async () => {
    const rounds: unknown[] = [];
    const { bridge } = fakeBridge();
    bridge.call = (_tool, input, { resume }) => {
      rounds.push(resume);
      return Promise.resolve(
        resume
          ? { data: { sent: input, answer: resume.inputResponses.confirm?.action } }
          : fromToolResult({
              resultType: "input_required",
              inputRequests: {
                confirm: { method: "elicitation/create", params: { message: "Send it?", requestedSchema: {} } },
                roots: { method: "roots/list" },
              },
              requestState: "opaque-state",
            }),
      );
    };
    const root = recorder();
    const started = await startView({
      views: { "invoices/browser": root.module },
      boot,
      bridge,
      element: document.body,
    });
    const pending = started.props().emit.call("send", { id: "inv_1" });
    await vi.waitFor(() => {
      expect(root.last()?.prompt?.message).toBe("Send it?");
    });
    root.last()?.prompt?.answer({ action: "accept", content: {} });
    await expect(pending).resolves.toEqual({ sent: { id: "inv_1" }, answer: "accept" });
    expect(root.last()?.prompt).toBeUndefined();
    expect(rounds).toEqual([
      undefined,
      {
        inputResponses: { confirm: { action: "accept", content: {} }, roots: { action: "decline" } },
        requestState: "opaque-state",
      },
    ]);
  });

  it("routes calls through the view channel only when the root renders prompts and the server has one", async () => {
    const seen: (string | undefined)[] = [];
    const cases = [
      { handlesPrompts: true, viewCallTool: "syrinx_view_call" },
      { handlesPrompts: false, viewCallTool: "syrinx_view_call" },
      { handlesPrompts: true, viewCallTool: undefined },
    ];
    for (const { handlesPrompts, viewCallTool } of cases) {
      const { bridge } = fakeBridge();
      bridge.call = (_tool, _input, { viewCall }) => {
        seen.push(viewCall);
        return Promise.resolve({ data: {} });
      };
      const module = { ...recorder().module, handlesPrompts };
      const withChannel = { ...boot, ...(viewCallTool ? { viewCallTool } : {}) };
      const started = await startView({
        views: { "invoices/browser": module },
        boot: withChannel,
        bridge,
        element: document.body,
      });
      await started.props().emit.call("send", { id: "inv_1" });
    }
    expect(seen).toEqual(["syrinx_view_call", undefined, undefined]);
  });

  it("fails clearly when the bundle lacks the root view", async () => {
    await expect(startView({ views: {}, boot, bridge: fakeBridge().bridge })).rejects.toThrow(/no module/);
  });
});
