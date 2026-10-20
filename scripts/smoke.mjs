// Runtime smoke test against the built packages. Uses only web-standard APIs,
// so the same file runs under Node (`node`), Bun (`bun`) and Deno (`deno run`).
import { createMemoryIdempotencyStore, createRegistry, defineApp, op } from "@syrinx/core";
import { createMcpSurface } from "@syrinx/mcp";
import { createRestApp } from "@syrinx/rest";

const any = {
  "~standard": {
    version: 1,
    vendor: "smoke",
    validate: (value) => ({ value }),
    jsonSchema: { input: () => ({}), output: () => ({}) },
  },
};

const echo = defineApp({
  name: "echo",
  version: "0.0.0",
  description: "Echoes its input.",
  operations: {
    say: op({
      description: "Return the input unchanged.",
      input: any,
      output: any,
      visibility: ["rest", "model"],
      handler: (input) => input,
    }),
    // Confirmation and idempotency exercise Web Crypto: sealed request state and input hashing.
    shout: op({
      description: "Return the input after the caller confirms.",
      input: any,
      output: any,
      visibility: ["rest", "model"],
      confirm: () => "Shout it?",
      handler: (input) => input,
    }),
  },
});

const registry = createRegistry([echo], {
  requestStateKey: "smoke-only-request-state-key-0123456789",
  idempotency: createMemoryIdempotencyStore(),
});
const app = createRestApp({ registry });

const post = async (path, body, headers = {}) => {
  const res = await app.request(path, { method: "POST", body: JSON.stringify(body), headers });
  return { status: res.status, body: await res.json() };
};
const check = (ok, label, res) => {
  if (ok) return;
  console.error(`smoke test failed: ${label}`, res.status, res.body);
  throw new Error(`smoke test failed: ${label}`);
};

const said = await post("/api/echo/ops/say", { hello: "world" });
check(said.status === 200 && said.body.data?.hello === "world", "echo", said);

const keyed = { "idempotency-key": "smoke-1" };
await post("/api/echo/ops/say", { n: 1 }, keyed);
const replayed = await post("/api/echo/ops/say", { n: 1 }, keyed);
check(replayed.status === 200 && replayed.body.meta?.replayed === true, "idempotent replay", replayed);

const asked = await post("/api/echo/ops/shout", { hello: "world" });
check(asked.body.resultType === "input_required" && typeof asked.body.requestState === "string", "confirm", asked);
const [question] = Object.keys(asked.body.inputRequests);
const resumed = await post("/api/echo/ops/shout/resume", {
  input: { hello: "world" },
  requestState: asked.body.requestState,
  inputResponses: { [question]: { action: "accept" } },
});
check(resumed.status === 200 && resumed.body.data?.hello === "world", "resume", resumed);

// The MCP surface over the same registry, as a 2026-07-28 client would call it.
const mcp = createMcpSurface({ registry, name: "smoke", version: "0.0.0" });
const rpc = async (method, params = {}) => {
  const res = await mcp.fetch(
    new Request("http://localhost/mcp/echo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(params.name ? { "mcp-name": params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "smoke", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );
  return { status: res.status, body: await res.json() };
};
const listed = await rpc("tools/list");
check(listed.body.result?.tools?.map((t) => t.name).join() === "say,shout", "mcp tools/list", listed);
const called = await rpc("tools/call", { name: "say", arguments: { hello: "mcp" } });
check(called.body.result?.structuredContent?.hello === "mcp", "mcp tools/call", called);

console.log("smoke ok");
