// Runtime smoke test against the built packages. Uses only web-standard APIs,
// so the same file runs under Node (`node`), Bun (`bun`) and Deno (`deno run`).
import { createRegistry, defineApp, op } from "@syrinx/core";
import { createRestApp } from "@syrinx/rest";

const any = { "~standard": { version: 1, vendor: "smoke", validate: (value) => ({ value }) } };

const echo = defineApp({
  name: "echo",
  version: "0.0.0",
  description: "Echoes its input.",
  operations: {
    say: op({ description: "Return the input unchanged.", input: any, output: any, handler: (input) => input }),
  },
});

const app = createRestApp({ registry: createRegistry([echo]) });
const res = await app.request("/api/echo/ops/say", { method: "POST", body: JSON.stringify({ hello: "world" }) });
const body = await res.json();

if (res.status !== 200 || body.data?.hello !== "world") {
  console.error("smoke test failed", res.status, body);
  throw new Error("smoke test failed");
}
console.log("smoke ok");
