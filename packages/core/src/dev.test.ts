import { describe, expect, it, vi } from "vitest";
import type { Principal } from "./context.js";
import {
  anonymousInDev,
  DEV_REQUEST_STATE_KEY,
  devTokens,
  requestStateKeyFromEnv,
  resolveRequestStateKey,
  resolveRequireAuth,
} from "./dev.js";

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

describe("devTokens", () => {
  const authenticate = devTokens({ viewer }, { production: false });
  const bearer = (value: string) => request({ authorization: value });

  it("maps a bearer token to its principal, and treats no header as anonymous", async () => {
    expect(await authenticate(bearer("Bearer viewer"))).toBe(viewer);
    expect(await authenticate(bearer("bearer  viewer"))).toBe(viewer);
    expect(await authenticate(request())).toBeUndefined();
    expect(await authenticate(bearer(""))).toBeUndefined();
  });

  it("reads tokens added after creation", async () => {
    const tokens: Record<string, Principal> = {};
    const late = devTokens(tokens, { production: false });
    tokens.viewer = viewer;
    expect(await late(bearer("Bearer viewer"))).toBe(viewer);
  });

  it("refuses unknown tokens, other schemes and inherited property names", () => {
    for (const header of ["Bearer nope", "viewer", "Basic viewer", "Bearer ", "Bearer toString", "Bearer __proto__"]) {
      expect(() => authenticate(bearer(header)), header).toThrow(
        expect.objectContaining({ kind: "unauthenticated" }) as Error,
      );
    }
  });

  it("refuses to be created in production", () => {
    expect(() => devTokens({ viewer }, { production: true })).toThrow(/not allowed in production/);
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => devTokens({ viewer })).toThrow(/not allowed in production/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("request-state key from the environment", () => {
  const withEnv = (vars: Record<string, string>, run: () => void) => {
    for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
    try {
      run();
    } finally {
      vi.unstubAllEnvs();
    }
  };

  it("reads SYRINX_REQUEST_STATE_KEY as a comma-separated list, newest first", () => {
    withEnv({ SYRINX_REQUEST_STATE_KEY: " new-key , old-key,," }, () => {
      expect(requestStateKeyFromEnv()).toEqual(["new-key", "old-key"]);
    });
    withEnv({ SYRINX_REQUEST_STATE_KEY: " , " }, () => {
      expect(requestStateKeyFromEnv()).toBeUndefined();
    });
  });

  it("prefers an explicit key, then the environment", () => {
    const warn = vi.fn();
    withEnv({ SYRINX_REQUEST_STATE_KEY: "from-env", NODE_ENV: "production" }, () => {
      expect(resolveRequestStateKey("explicit", { warn })).toBe("explicit");
      expect(resolveRequestStateKey(undefined, { warn })).toEqual(["from-env"]);
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the development key with a warning outside production", () => {
    const warn = vi.fn();
    withEnv({ SYRINX_REQUEST_STATE_KEY: "" }, () => {
      expect(resolveRequestStateKey(undefined, { warn, production: false })).toBe(DEV_REQUEST_STATE_KEY);
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SYRINX_REQUEST_STATE_KEY"));
  });

  it("refuses to fall back in production", () => {
    withEnv({ SYRINX_REQUEST_STATE_KEY: "", NODE_ENV: "production" }, () => {
      expect(() => resolveRequestStateKey(undefined)).toThrow(/set SYRINX_REQUEST_STATE_KEY/);
    });
    expect(() => resolveRequestStateKey(undefined, { production: true })).toThrow(/No request-state key/);
  });
});

describe("resolveRequireAuth", () => {
  const authenticate = () => undefined;

  it("follows the explicit setting, else NODE_ENV", () => {
    expect(resolveRequireAuth(undefined, authenticate, { production: false })).toBe(false);
    expect(resolveRequireAuth(undefined, authenticate, { production: true })).toBe(true);
    expect(resolveRequireAuth(false, undefined, { production: true })).toBe(false);
    expect(resolveRequireAuth(true, authenticate, { production: false })).toBe(true);
  });

  it("refuses to require auth with nothing to authenticate", () => {
    expect(() => resolveRequireAuth(undefined, undefined, { production: true })).toThrow(/default under NODE_ENV/);
    expect(() => resolveRequireAuth(true, undefined)).toThrow(/no authenticate/);
  });
});
