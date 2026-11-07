import type { Principal } from "./context.js";
import type { Secret } from "./crypto.js";

// Core carries no Node types; this also holds on runtimes without `process`.
const env = () => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

/** Whether `NODE_ENV` is `production`; false on runtimes without `process`. */
export const isProduction = () => env()?.NODE_ENV === "production";

type Authenticate = (request: Request) => Principal | undefined | Promise<Principal | undefined>;

export interface AnonymousInDevOptions {
  /** Where the one-time warning goes. Defaults to `console.warn`. */
  warn?: (message: string) => void;
  /** Overrides the production check, for tests. Defaults to `NODE_ENV === "production"`. */
  production?: boolean;
}

/**
 * Development only: lets callers with no credentials act as `principal`, for clients that cannot send a token (MCP
 * connectors in Claude Desktop send none) while the app is exposed through a tunnel. Credentials, when present, still
 * go through `authenticate`, so a bad token is still refused. Throws at creation when `NODE_ENV` is `production`, and
 * warns once when first used, so it cannot be left on unnoticed.
 */
export function anonymousInDev(
  authenticate: Authenticate,
  principal: Principal,
  options: AnonymousInDevOptions = {},
): Authenticate {
  const production = options.production ?? isProduction();
  if (production)
    throw new Error("anonymousInDev gives callers without credentials access; it is not allowed in production.");
  const warn =
    options.warn ??
    ((message: string) => {
      console.warn(message);
    });
  let warned = false;
  return async (request) => {
    const found = await authenticate(request);
    if (found) return found;
    if (!warned) {
      warned = true;
      warn(`[syrinx] anonymousInDev: callers without credentials act as "${principal.id}". Development only.`);
    }
    return principal;
  };
}

export type ResolveRequireAuthOptions = Pick<AnonymousInDevOptions, "production">;

/**
 * Whether a surface refuses anonymous callers: `requireAuth` when given, else on under `NODE_ENV=production`. Throws
 * when it is on but there is no `authenticate`, since every caller would then be refused.
 */
export function resolveRequireAuth(
  requireAuth: boolean | undefined,
  authenticate: unknown,
  options: ResolveRequireAuthOptions = {},
): boolean {
  const required = requireAuth ?? options.production ?? isProduction();
  if (required && !authenticate)
    throw new Error(
      `requireAuth is on${requireAuth === undefined ? " (the default under NODE_ENV=production)" : ""} but there is no authenticate, so every caller would be refused. Pass authenticate, or requireAuth: false to serve anonymous callers.`,
    );
  return required;
}

/** The environment variable `requestStateKey` is read from: one key, or several separated by commas, newest first. */
export const REQUEST_STATE_KEY_ENV = "SYRINX_REQUEST_STATE_KEY";

/** The key hosts fall back to in development. Anyone can read it here, so it protects nothing. */
export const DEV_REQUEST_STATE_KEY = "dev-only-request-state-key-change-me!";

/** The keys in `SYRINX_REQUEST_STATE_KEY`, newest first; undefined when it is unset or empty. */
export function requestStateKeyFromEnv(): string[] | undefined {
  const keys = (env()?.[REQUEST_STATE_KEY_ENV] ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  return keys.length > 0 ? keys : undefined;
}

export type ResolveRequestStateKeyOptions = AnonymousInDevOptions;

/**
 * The request-state key a host runs with: `explicit` when given, else `SYRINX_REQUEST_STATE_KEY`, else the built-in
 * development key with a warning. Throws when it would fall back under `NODE_ENV=production`, since state sealed with a
 * public key can be forged and instances that disagree on the key cannot resume each other's questions.
 */
export function resolveRequestStateKey(
  explicit: Secret | readonly Secret[] | undefined,
  options: ResolveRequestStateKeyOptions = {},
): Secret | readonly Secret[] {
  const key = explicit ?? requestStateKeyFromEnv();
  if (key !== undefined) return key;
  if (options.production ?? isProduction())
    throw new Error(
      `No request-state key: set ${REQUEST_STATE_KEY_ENV} (at least 32 bytes; several, comma-separated, to rotate) or pass requestStateKey.`,
    );
  const warn =
    options.warn ??
    ((message: string) => {
      console.warn(message);
    });
  warn(
    `[syrinx] No ${REQUEST_STATE_KEY_ENV}; using the built-in development request-state key. Set one before deploying.`,
  );
  return DEV_REQUEST_STATE_KEY;
}
