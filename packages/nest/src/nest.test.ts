import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Body, Controller, Get, Injectable, Module, Post, type INestApplication } from "@nestjs/common";
import { defineApp, errors, op } from "@syrinx/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createSyrinxApp, listen, SyrinxModule, type NestContext } from "./index.js";

@Injectable()
class Greeter {
  greet(name: string) {
    return `Hello, ${name}`;
  }
}

@Controller()
class PingController {
  @Get("ping") ping() {
    return { pong: true };
  }
  @Post("echo") echo(@Body() body: unknown) {
    return body;
  }
}

const greetings = defineApp({
  name: "greetings",
  version: "1.0.0",
  description: "Greets people.",
  operations: {
    greet: op({
      description: "Greet by name.",
      input: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
      annotations: { readOnly: true },
      handler: ({ name }, ctx: NestContext) => ({ message: ctx.deps.nest.get(Greeter).greet(name) }),
    }),
    secret: op({
      description: "Needs a scope.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      annotations: { readOnly: true },
      permissions: ["secret:read"],
      handler: () => ({ ok: true }),
    }),
  },
});

@Module({
  providers: [Greeter],
  controllers: [PingController],
  imports: [
    SyrinxModule.forRoot({
      apps: [greetings],
      authenticate: (request) => {
        const token = request.headers.get("authorization");
        if (!token) return undefined;
        if (token === "Bearer ok") return { id: "u1", scopes: ["secret:read"] };
        if (token === "Bearer limited") return { id: "u2", scopes: [] };
        throw errors.unauthenticated("Bad token.");
      },
    }),
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- a Nest module is a class that only carries metadata
class AppModule {}

let app: INestApplication;
let server: Server;
let base: string;

beforeAll(async () => {
  app = await createSyrinxApp(AppModule, { logger: false });
  server = await listen(app, 0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await app.close();
});

const call = (operation: string, input: unknown, token?: string) =>
  fetch(`${base}/api/greetings/ops/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(input),
  });

describe("@syrinx/nest", () => {
  it("serves Nest's routes, including JSON bodies, beside Syrinx", async () => {
    expect(await (await fetch(`${base}/ping`)).json()).toEqual({ pong: true });
    const echoed = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(await echoed.json()).toEqual({ a: 1 });
  });

  it("lets an operation reach a Nest provider", async () => {
    const response = await call("greet", { name: "Ada" }, "ok");
    expect(((await response.json()) as { data: unknown }).data).toEqual({ message: "Hello, Ada" });
  });

  it("uses the authenticate option for scopes and bad tokens", async () => {
    expect((await call("secret", {}, "ok")).status).toBe(200);
    expect((await call("secret", {}, "limited")).status).toBe(403);
    expect((await call("secret", {})).status).toBe(401);
    expect((await call("secret", {}, "nope")).status).toBe(401);
  });

  it("serves MCP", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(await response.text()).toContain("greetings");
  });
});
