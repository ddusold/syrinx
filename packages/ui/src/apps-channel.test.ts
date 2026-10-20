// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPS_PROTOCOL_VERSION, applyHostStyles, createAppsChannel, type AppsChannel } from "./apps-channel.js";
import { createMcpBridge } from "./mcp.js";

interface Sent {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A host window: records what the view posts, and answers requests from a table, as AppBridge would. */
function fakeHost(answers: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  const sent: Sent[] = [];
  const host = {
    postMessage(message: Sent) {
      sent.push(message);
      const answer = message.method !== undefined && message.id !== undefined ? answers[message.method] : undefined;
      if (answer)
        queueMicrotask(() => {
          deliver({ jsonrpc: "2.0", id: message.id, result: answer(message.params ?? {}) });
        });
    },
  } as unknown as Window;
  const deliver = (data: unknown, source: unknown = host) => {
    window.dispatchEvent(new MessageEvent("message", { data, source: source as Window }));
  };
  return { host, sent, deliver };
}

const channels: AppsChannel[] = [];
const open = (host: Window, timeoutMs?: number) => {
  const channel = createAppsChannel({ host, ...(timeoutMs ? { timeoutMs } : {}) });
  channels.push(channel);
  return channel;
};
afterEach(() => {
  channels.splice(0).forEach((c) => {
    c.close();
  });
});

describe("MCP Apps channel", () => {
  it("handshakes with ui/initialize and the protocol version, then sends initialized", async () => {
    const { host, sent } = fakeHost({ "ui/initialize": () => ({ hostContext: { theme: "dark" } }) });
    await expect(open(host).connect()).resolves.toEqual({ theme: "dark" });
    expect(sent[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "ui/initialize",
      params: { protocolVersion: APPS_PROTOCOL_VERSION, appCapabilities: {}, appInfo: { name: "syrinx-view" } },
    });
    expect(sent[1]).toEqual({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  });

  it("matches responses to requests and turns JSON-RPC errors into rejections", async () => {
    const { host, sent, deliver } = fakeHost();
    const channel = open(host);
    const first = channel.request("tools/call", { name: "a" });
    const second = channel.request("tools/call", { name: "b" });
    const [a, b] = sent;
    deliver({ jsonrpc: "2.0", id: b?.id, error: { code: -32602, message: "bad" } });
    deliver({ jsonrpc: "2.0", id: a?.id, result: { ok: true } });
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).rejects.toMatchObject({ name: "AppsProtocolError", code: -32602, message: "bad" });
  });

  it("sends plain JSON, so proxies such as Vue refs can cross postMessage", () => {
    const { host, sent } = fakeHost();
    const reactive = new Proxy({ id: "inv_1" }, {});
    // Never answered; close() in afterEach rejects it, so swallow that here.
    open(host)
      .request("tools/call", { name: "send", arguments: reactive })
      .catch(() => undefined);
    const sentArgs = sent[0]?.params?.arguments;
    expect(sentArgs).toEqual({ id: "inv_1" });
    expect(sentArgs).not.toBe(reactive);
    expect(() => structuredClone(sent[0])).not.toThrow();
  });

  it("ignores messages from anything but the host window", async () => {
    const { host, sent, deliver } = fakeHost();
    const channel = open(host, 50);
    const handler = vi.fn();
    channel.on("ui/notifications/tool-result", handler);
    const pending = channel.request("ping");
    deliver({ jsonrpc: "2.0", id: sent[0]?.id, result: {} }, {});
    deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {} }, window);
    await expect(pending).rejects.toThrow(/did not answer ping/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers teardown and ping, refuses other host requests, and dispatches notifications", () => {
    const { host, sent, deliver } = fakeHost();
    const channel = open(host);
    const handler = vi.fn();
    channel.on("ui/notifications/host-context-changed", handler);
    deliver({ jsonrpc: "2.0", id: 7, method: "ui/resource-teardown", params: {} });
    deliver({ jsonrpc: "2.0", id: 8, method: "ui/whatever", params: {} });
    deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light" } });
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 7, result: {} },
      { jsonrpc: "2.0", id: 8, error: { code: -32601, message: "Method not found: ui/whatever" } },
    ]);
    expect(handler).toHaveBeenCalledWith({ theme: "light" });
  });

  it("applies host CSS variables and fonts once", () => {
    applyHostStyles({
      styles: { variables: { "--color-text-primary": "#123456" }, css: { fonts: "@font-face{font-family:X}" } },
    });
    applyHostStyles({ styles: { css: { fonts: "@font-face{font-family:Y}" } } });
    expect(document.documentElement.style.getPropertyValue("--color-text-primary")).toBe("#123456");
    expect(document.querySelectorAll("#__mcp-host-fonts")).toHaveLength(1);
  });
});

describe("MCP bridge", () => {
  it("calls tools with the app surface mark and the retry channel, and opens links", async () => {
    const { host, sent } = fakeHost({
      "ui/initialize": () => ({ hostContext: { theme: "dark", locale: "de-DE", styles: {} } }),
      "tools/call": () => ({ structuredContent: { id: "inv_1" } }),
      "ui/open-link": () => ({}),
    });
    const bridge = createMcpBridge(open(host));
    await bridge.connect();
    expect(bridge.host()).toEqual({ theme: "dark", locale: "de-DE" });

    const resume = { inputResponses: { c: { action: "accept" as const } }, requestState: "s" };
    await expect(bridge.call("send", { id: "inv_1" }, { app: "invoices", operation: "send", resume })).resolves.toEqual(
      {
        data: { id: "inv_1" },
      },
    );
    await bridge.openLink("https://example.com");
    expect(sent.find((m) => m.method === "tools/call")?.params).toEqual({
      name: "send",
      arguments: { id: "inv_1" },
      _meta: { "io.github.ddusold.syrinx/surface": "app" },
      ...resume,
    });
    expect(sent.find((m) => m.method === "ui/open-link")?.params).toEqual({ url: "https://example.com" });
  });

  it("calls through the view channel: questions come back as data, answers go back as arguments", async () => {
    const { host, sent } = fakeHost({
      "tools/call": (params) => {
        const args = params.arguments as { resume?: unknown };
        const envelope = args.resume
          ? {
              resultType: "complete",
              data: { voided: true },
              view: { view: "invoices/browser", op: "void", schemaVersion: "v" },
            }
          : {
              resultType: "input_required",
              inputRequests: { c: { method: "elicitation/create", params: { message: "Void?", requestedSchema: {} } } },
              requestState: "sealed",
            };
        return { content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: envelope };
      },
    });
    const bridge = createMcpBridge(open(host));
    const target = { app: "invoices", operation: "void", viewCall: "syrinx_view_call" };
    await expect(bridge.call("void", { id: "inv_1" }, target)).resolves.toEqual({
      input: { requests: { c: { message: "Void?", fields: {} } }, requestState: "sealed" },
    });
    const resume = { inputResponses: { c: { action: "accept" as const } }, requestState: "sealed" };
    await expect(bridge.call("void", { id: "inv_1" }, { ...target, resume })).resolves.toEqual({
      data: { voided: true },
      view: { view: "invoices/browser", op: "void", schemaVersion: "v" },
    });
    const calls = sent.filter((m) => m.method === "tools/call").map((m) => m.params);
    expect(calls).toEqual([
      {
        name: "syrinx_view_call",
        arguments: { app: "invoices", operation: "void", input: { id: "inv_1" } },
        _meta: { "io.github.ddusold.syrinx/surface": "app" },
      },
      {
        name: "syrinx_view_call",
        arguments: { app: "invoices", operation: "void", input: { id: "inv_1" }, resume },
        _meta: { "io.github.ddusold.syrinx/surface": "app" },
      },
    ]);
  });

  it("reads the channel's JSON text when a host drops structuredContent", async () => {
    const envelope = { resultType: "error", error: { kind: "forbidden", message: "no" } };
    const { host } = fakeHost({
      "tools/call": () => ({ isError: true, content: [{ type: "text", text: JSON.stringify(envelope) }] }),
    });
    const bridge = createMcpBridge(open(host));
    await expect(
      bridge.call("send", {}, { app: "invoices", operation: "send", viewCall: "syrinx_view_call" }),
    ).resolves.toMatchObject({ error: { kind: "forbidden", message: "no" } });
  });

  it("falls back to calling the operation directly when the server refuses the channel", async () => {
    const { host, sent } = fakeHost({
      "tools/call": (params) =>
        params.name === "syrinx_view_call"
          ? { isError: true, structuredContent: { resultType: "error", error: { kind: "unavailable", message: "no" } } }
          : { structuredContent: { id: "inv_1" } },
    });
    const bridge = createMcpBridge(open(host));
    const target = { app: "invoices", operation: "send", viewCall: "syrinx_view_call" };
    await expect(bridge.call("send", { id: "inv_1" }, target)).resolves.toEqual({ data: { id: "inv_1" } });
    await bridge.call("send", { id: "inv_1" }, target);
    expect(sent.filter((m) => m.method === "tools/call").map((m) => m.params?.name)).toEqual([
      "syrinx_view_call",
      "send",
      "send", // the channel is not tried again
    ]);
  });

  it("reports host failures as view errors", async () => {
    const { host, deliver, sent } = fakeHost();
    const bridge = createMcpBridge(open(host));
    const pending = bridge.call("send", {}, { app: "invoices", operation: "send" });
    deliver({ jsonrpc: "2.0", id: sent[0]?.id, error: { code: -32603, message: "host exploded" } });
    await expect(pending).resolves.toMatchObject({ error: { kind: "host", message: "host exploded" } });
  });
});
