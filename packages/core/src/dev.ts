import type { Principal } from "./context.js";

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
  // Core carries no Node types; this also holds on runtimes without `process`.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const production = options.production ?? env?.NODE_ENV === "production";
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
