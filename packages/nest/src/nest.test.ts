import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Body, Controller, Get, Injectable, Logger, Module, Post, type INestApplication } from "@nestjs/common";
import { defineApp, errors, op, SyrinxError } from "@syrinx/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSyrinxApp, listen, nestLogger, remoteApp, SyrinxModule, type NestContext } from "./index.js";

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

describe("request-state key", () => {
  it("refuses to start in production without one", async () => {
    @Module({ imports: [SyrinxModule.forRoot({ apps: [greetings] })] })
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- a Nest module is a class that only carries metadata
    class KeylessModule {}
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SYRINX_REQUEST_STATE_KEY", "");
    try {
      const keyless = await createSyrinxApp(KeylessModule, { logger: false });
      await expect(keyless.init()).rejects.toThrow(/SYRINX_REQUEST_STATE_KEY/);
      await keyless.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("principals", () => {
  it("authenticates demo tokens through devTokens, so inherited names are not tokens", async () => {
    @Module({
      imports: [
        SyrinxModule.forRoot({
          apps: [greetings],
          principals: { ok: { id: "u1", scopes: ["secret:read"] } },
        }),
      ],
    })
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- a Nest module is a class that only carries metadata
    class DemoModule {}
    const demo = await createSyrinxApp(DemoModule, { logger: false });
    const demoServer = await listen(demo, 0);
    try {
      const url = `http://localhost:${(demoServer.address() as AddressInfo).port}/api/greetings/ops/secret`;
      const post = (token: string) =>
        fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
      expect((await post("ok")).status).toBe(200);
      expect((await post("toString")).status).toBe(401);
    } finally {
      demoServer.close();
      await demo.close();
    }
  });

  it("refuses to start in production", async () => {
    @Module({ imports: [SyrinxModule.forRoot({ apps: [greetings], principals: {}, requestStateKey: "k".repeat(32) })] })
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- a Nest module is a class that only carries metadata
    class DemoModule {}
    vi.stubEnv("NODE_ENV", "production");
    try {
      const demo = await createSyrinxApp(DemoModule, { logger: false });
      await expect(demo.init()).rejects.toThrow(/devTokens/);
      await demo.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("remoteApp", () => {
  it("calls another Syrinx app's operations and rethrows its failures as SyrinxErrors", async () => {
    const remote = remoteApp<typeof greetings>({ app: "greetings", base: `${base}/api` });
    const signedIn = remoteApp<typeof greetings>({
      app: "greetings",
      base: `${base}/api`,
      headers: () => ({ authorization: "Bearer ok" }),
    });
    expect(await signedIn.greet({ name: "Ada" })).toEqual({ message: "Hello, Ada" });
    expect(await signedIn.secret({})).toEqual({ ok: true });
    // A validation error keeps its field issues; a missing credential stays unauthenticated, as a SyrinxError.
    await expect(signedIn.greet({ name: 1 as unknown as string })).rejects.toMatchObject({ kind: "validation" });
    await expect(remote.secret({})).rejects.toMatchObject({ kind: "unauthenticated" });
    await expect(remote.secret({})).rejects.toBeInstanceOf(SyrinxError);
    // A service that is not there is a bad gateway, not a crash.
    const gone = remoteApp<typeof greetings>({ app: "greetings", base: "http://localhost:1/api" });
    await expect(gone.greet({ name: "x" })).rejects.toMatchObject({ kind: "upstream" });
  });
});

describe("nestLogger", () => {
  it("writes through Nest's logger, passing the stack apart so Nest prints it beneath the line", () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const logger = nestLogger();
      logger.error("unhandled error", { "syrinx.app": "a", "error.stack": "Error: x\n    at f (file.ts:1:1)" });
      logger.warn("lint");
      expect(error).toHaveBeenCalledWith('unhandled error {"syrinx.app":"a"}', "Error: x\n    at f (file.ts:1:1)");
      expect(warn).toHaveBeenCalledWith("lint");
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
