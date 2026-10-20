import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createRegistry, defineApp, op } from "@syrinx/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { serveRegistryStdio } from "./stdio.js";

const notes = defineApp({
  name: "notes",
  version: "1.0.0",
  description: "Personal notes.",
  operations: {
    whoami: op({
      description: "Report which local user the server runs as.",
      input: z.object({}),
      output: z.object({ id: z.string() }),
      annotations: { readOnly: true },
      handler: (_input, ctx) => ({ id: ctx.principal.id }),
    }),
    clear: op({
      description: "Delete every note after the user confirms.",
      input: z.object({}),
      output: z.object({ cleared: z.boolean() }),
      visibility: ["model"],
      annotations: { destructive: true, asks: true },
      handler: async (_input, ctx) => ({ cleared: await ctx.confirm("Delete every note?") }),
    }),
  },
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(era: "legacy" | "auto") {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveRegistryStdio({
    registry: createRegistry([notes], { requestStateKey: "stdio-test-request-state-key-32-bytes" }),
    name: "notes",
    version: "1.0.0",
    app: "notes",
    principal: { id: "local-user", scopes: [] },
    transport: serverSide,
  });
  const client = new Client(
    { name: "stdio-test", version: "0.0.0" },
    { versionNegotiation: { mode: era }, capabilities: { elicitation: {} } },
  );
  const asked: string[] = [];
  client.setRequestHandler("elicitation/create", (request) => {
    asked.push(request.params.message);
    return { action: "accept" };
  });
  await client.connect(clientSide);
  closers.push(
    () => client.close(),
    () => handle.close(),
  );
  return { client, asked };
}

describe.each(["legacy", "auto"] as const)("stdio (%s negotiation)", (era) => {
  it("serves one app unprefixed, as the configured local principal", async () => {
    const { client } = await connect(era);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["whoami", "clear"]);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.structuredContent).toEqual({ id: "local-user" });
  });

  it("asks questions on both eras, since the connection stays open", async () => {
    const { client, asked } = await connect(era);
    const result = await client.callTool({ name: "clear", arguments: {} });
    expect(asked).toEqual(["Delete every note?"]);
    expect(result.structuredContent).toEqual({ cleared: true });
  });
});

it("rejects an unknown app at startup", () => {
  expect(() => serveRegistryStdio({ registry: createRegistry([notes]), name: "n", version: "0", app: "nope" })).toThrow(
    /Unknown app "nope"/,
  );
});
