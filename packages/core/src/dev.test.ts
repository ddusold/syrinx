import { describe, expect, it, vi } from "vitest";
import type { Principal } from "./context.js";
import { anonymousInDev } from "./dev.js";

const viewer: Principal = { id: "viewer", scopes: ["people.read"] };
const request = (headers: Record<string, string> = {}) => new Request("http://localhost/mcp", { headers });
const byToken = (found: Principal) => (r: Request) =>
  r.headers.get("authorization") === "Bearer ok" ? found : undefined;

describe("anonymousInDev", () => {
  it("lets callers without credentials act as the principal, and warns once", async () => {
    const warn = vi.fn();
    const authenticate = anonymousInDev(byToken({ id: "real", scopes: [] }), viewer, { warn });
    expect(await authenticate(request())).toBe(viewer);
    expect(await authenticate(request())).toBe(viewer);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Development only"));
  });

  it("keeps real credentials in charge, and still refuses bad ones", async () => {
    const real: Principal = { id: "real", scopes: [] };
    const warn = vi.fn();
    const authenticate = anonymousInDev(byToken(real), viewer, { warn });
    expect(await authenticate(request({ authorization: "Bearer ok" }))).toBe(real);
    expect(warn).not.toHaveBeenCalled();

    const strict = anonymousInDev(
      () => {
        throw new Error("unknown token");
      },
      viewer,
      { warn },
    );
    await expect(strict(request({ authorization: "Bearer nope" }))).rejects.toThrow("unknown token");
  });

  it("refuses to be created in production", () => {
    expect(() => anonymousInDev(() => undefined, viewer, { production: true })).toThrow(/not allowed in production/);
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => anonymousInDev(() => undefined, viewer)).toThrow(/not allowed in production/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
