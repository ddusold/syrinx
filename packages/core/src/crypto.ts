// Small Web Crypto helpers, so core runs unchanged on Node, Bun and Deno.

const encoder = new TextEncoder();

/** JSON with object keys sorted at every level, so equal values always hash the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function sha256(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** A secret for sealing tokens: at least 32 bytes, as text or raw bytes. */
export type Secret = string | Uint8Array;

/** Derives an AES-256-GCM key from a secret with HKDF, so any 32+ byte secret becomes a proper encryption key. */
export async function sealingKey(secret: Secret): Promise<CryptoKey> {
  const raw = typeof secret === "string" ? encoder.encode(secret) : new Uint8Array(secret);
  if (raw.byteLength < 32) throw new RangeError("Sealing keys must be at least 32 bytes.");
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("syrinx"), info: encoder.encode("request-state/v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts and authenticates a JSON payload: `iv.ciphertext`, both base64url. Unreadable and unforgeable without the key. */
export async function seal(key: CryptoKey, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload)));
  return `${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}

/** The payload if any of the keys opens the token, otherwise undefined. Trying each key is what makes rotation work. */
export async function unseal(keys: readonly CryptoKey[], token: string): Promise<unknown> {
  const [iv, ciphertext, extra] = token.split(".");
  if (!iv || !ciphertext || extra !== undefined) return undefined;
  for (const key of keys) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64url(iv) },
        key,
        fromBase64url(ciphertext),
      );
      return JSON.parse(new TextDecoder().decode(plain)) as unknown;
    } catch {
      // wrong key or tampered token; try the next key
    }
  }
  return undefined;
}
