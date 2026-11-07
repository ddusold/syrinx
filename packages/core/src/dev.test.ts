import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Principal } from "./context.js";
import {
  anonymousInDev,
  DEV_REQUEST_STATE_KEY,
  localAuthBypass,
  requestStateKeyFromEnv,
  resolveRequestStateKey,
  resolveRequireAuth,
} from "./dev.js";
import { defineApp, op, prompt, resource } from "./index.js";

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
  it("follows the explicit setting, else NODE_ENV", () => {
    expect(resolveRequireAuth(undefined, true, { production: false })).toBe(false);
    expect(resolveRequireAuth(undefined, true, { production: true })).toBe(true);
    expect(resolveRequireAuth(false, false, { production: true })).toBe(false);
    expect(resolveRequireAuth(true, true, { production: false })).toBe(true);
  });

  it("refuses to require auth with nothing to authenticate", () => {
    expect(() => resolveRequireAuth(undefined, false, { production: true })).toThrow(/default under NODE_ENV/);
    expect(() => resolveRequireAuth(true, false)).toThrow(/no authenticate/);
  });
});

describe("localAuthBypass", () => {
  const notes = defineApp({
    name: "notes",
    version: "1",
    description: "Notes.",
    operations: {
      write: op({
        description: "Write a note.",
        input: z.object({}),
        output: z.object({}),
        visibility: ["model", "rest"],
        permissions: ["notes:write"],
        handler: () => ({}),
      }),
      owned: op({
        description: "A note its owner may read.",
        input: z.object({}),
        output: z.object({}),
        annotations: { readOnly: true },
        permissions: (principal) => principal.id === "owner",
        handler: () => ({}),
      }),
    },
    resources: {
      note: resource({ uri: "note://{id}", output: z.object({}), permissions: ["notes:read"], read: () => ({}) }),
    },
    prompts: {
      digest: prompt({ description: "Digest the notes.", permissions: ["notes:digest"], render: () => "Digest." }),
    },
  });
  const withBypass = (value: string, run: () => void) => {
    vi.stubEnv("SYRINX_LOCAL_BYPASS_AUTH", value);
    try {
      run();
    } finally {
      vi.unstubAllEnvs();
    }
  };

  it("is off unless the variable is set", () => {
    expect(localAuthBypass([notes])).toBeUndefined();
    withBypass("0", () => {
      expect(localAuthBypass([notes])).toBeUndefined();
    });
    withBypass("false", () => {
      expect(localAuthBypass([notes])).toBeUndefined();
    });
  });

  it("acts as a local principal holding every declared scope, and warns", () => {
    for (const value of ["1", "true", "TRUE"]) {
      withBypass(value, () => {
        const warn = vi.fn();
        expect(localAuthBypass([notes], { warn, production: false })).toEqual({
          id: "local",
          scopes: ["notes:digest", "notes:read", "notes:write"],
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("authentication is off"));
      });
    }
  });

  it("refuses production and values it does not understand", () => {
    withBypass("1", () => {
      expect(() => localAuthBypass([notes], { production: true })).toThrow(/not allowed in production/);
    });
    withBypass("yes", () => {
      expect(() => localAuthBypass([notes])).toThrow(/must be 1, true, 0 or false/);
    });
  });
});
