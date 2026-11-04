import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { View, ViewBoot, ViewCsp } from "@syrinx/core";

/** The file `@syrinx/vite` writes next to the bundles: one self-contained script (and styles) per root view. */
export interface ViewManifest {
  version: 1;
  /** Keyed `app/view`. Paths are relative to the manifest's directory. */
  views: Record<string, { js: string; css: string[] }>;
}

export const MANIFEST_FILE = "manifest.json";
const BOOT_ELEMENT_ID = "syrinx-boot";
const ROOT_ELEMENT_ID = "syrinx-root";

/** JSON safe inside a script element: no `</script>`, `<!--` or line separators can end it early. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(" ", "\\u2028").replaceAll(" ", "\\u2029");
const scriptText = (code: string) => code.replaceAll(/<\/(script)/gi, "<\\/$1").replaceAll("<!--", "<\\!--");
const styleText = (css: string) => css.replaceAll(/<\/(style)/gi, "<\\/$1");
const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** One asset as a shell references it: inlined, or hosted at a URL and pinned by its SRI hash. */
export type ShellAsset = { inline: string } | { url: string; integrity: string };

export interface ShellParts {
  title: string;
  boot: ViewBoot;
  script: ShellAsset;
  styles: readonly ShellAsset[];
}

/**
 * The HTML document an MCP Apps host loads into its sandboxed iframe. Hosts allow inline scripts and styles by
 * default; hosted assets need their origin in `resourceDomains`, and load with CORS so SRI can check them.
 */
export function renderShell({ title, boot, script, styles }: ShellParts): string {
  const style = (s: ShellAsset) =>
    "inline" in s
      ? `<style>${styleText(s.inline)}</style>`
      : `<link rel="stylesheet" href="${escapeHtml(s.url)}" integrity="${s.integrity}" crossorigin="anonymous">`;
  const js =
    "inline" in script
      ? `<script type="module">${scriptText(script.inline)}</script>`
      : `<script type="module" src="${escapeHtml(script.url)}" integrity="${script.integrity}" crossorigin="anonymous"></script>`;
  return [
    "<!doctype html>",
    `<html lang="en">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(title)}</title>`,
    ...styles.map(style),
    `<script type="application/json" id="${BOOT_ELEMENT_ID}">${scriptJson(boot)}</script>`,
    "</head>",
    "<body>",
    `<div id="${ROOT_ELEMENT_ID}"></div>`,
    js,
    "</body>",
    "</html>",
  ].join("\n");
}

const sri = (body: Buffer) => `sha384-${createHash("sha384").update(body).digest("base64")}`;

export interface ViewShellsOptions {
  /** The directory `@syrinx/vite` built into, holding `manifest.json`. */
  dir: string | URL;
  /**
   * Where the bundles are served (with {@link serveViewAssets}), such as `https://app.example.com/views/`. Shells
   * then reference them by URL with SRI and list the origin in `resourceDomains`. Omit to inline every bundle into
   * its shell, which needs no HTTP serving and suits stdio.
   */
  baseUrl?: string;
}

export interface LoadedViewShells {
  render(view: View, boot: ViewBoot): { html: string; csp?: ViewCsp };
  readonly manifest: ViewManifest;
  /** Bundle files keyed by their path in the manifest, with their SRI hashes. */
  readonly files: ReadonlyMap<string, { body: Buffer; integrity: string }>;
}

/**
 * Loads built bundles into a {@link LoadedViewShells} for `createMcpSurface({ views })`. Files are read once,
 * here, so rendering a shell never touches the disk.
 */
export async function loadViewShells(options: ViewShellsOptions): Promise<LoadedViewShells> {
  const dir = typeof options.dir === "string" ? options.dir : fileURLToPath(options.dir);
  const parsed = JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8")) as { version?: unknown };
  if (parsed.version !== 1) throw new Error(`Unsupported view manifest version ${String(parsed.version)}.`);
  const manifest = parsed as ViewManifest;

  const files = new Map<string, { body: Buffer; integrity: string }>();
  for (const entry of Object.values(manifest.views)) {
    for (const path of [entry.js, ...entry.css]) {
      const body = await readFile(join(dir, path));
      files.set(path, { body, integrity: sri(body) });
    }
  }

  const base = options.baseUrl && new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  const asset = (path: string): ShellAsset => {
    const file = files.get(path);
    if (!file) throw new Error(`View bundle ${path} is missing.`);
    return base ? { url: new URL(path, base).href, integrity: file.integrity } : { inline: file.body.toString("utf8") };
  };

  return {
    manifest,
    files,
    render(view, boot) {
      const id = `${view.app}/${view.name}`;
      const entry = manifest.views[id];
      if (!entry) throw new Error(`View ${id} has no bundle; rebuild the views.`);
      const html = renderShell({
        title: view.title ?? id,
        boot,
        script: asset(entry.js),
        styles: entry.css.map(asset),
      });
      return base ? { html, csp: { resourceDomains: [base.origin] } } : { html };
    },
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

/**
 * Serves bundles under `prefix` (default `/views/`). Bundle names carry content hashes, so responses are cached
 * for a year as immutable. Module scripts in a sandboxed iframe load cross-origin, hence the open CORS header.
 * Returns undefined for paths it does not serve, so it composes with other handlers.
 */
export function serveViewAssets(
  shells: Pick<LoadedViewShells, "files">,
  { prefix = "/views/" }: { prefix?: string } = {},
): (request: Request) => Response | undefined {
  return (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return undefined;
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(prefix)) return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      return new Response("Not found", { status: 404 }); // a malformed escape names no file
    }
    const path = normalize(decoded).split(sep).join("/");
    const file = path.startsWith("..") ? undefined : shells.files.get(path);
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : new Uint8Array(file.body), {
      headers: {
        "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
        "access-control-allow-origin": "*",
        etag: `"${file.integrity}"`,
      },
    });
  };
}

export interface WatchedViewShells {
  /** Re-reads the bundles first when a rebuild replaced them, so the next open of a view shows the new code. */
  render(view: View, boot: ViewBoot): Promise<{ html: string; csp?: ViewCsp }>;
  readonly manifest: ViewManifest;
  /** The current bundle files; follows rebuilds, so {@link serveViewAssets} can serve them as they change. */
  readonly files: ReadonlyMap<string, { body: Buffer; integrity: string }>;
}

/**
 * Like {@link loadViewShells}, for development: each render checks whether `manifest.json` changed and, if so, loads
 * the rebuilt bundles, so editing a view needs no server restart. Pass it to `createMcpSurface({ views })` and, with a
 * `baseUrl`, to {@link serveViewAssets}. Rebuild with `watchViews` from `@syrinx/vite`.
 */
export async function watchViewShells(options: ViewShellsOptions): Promise<WatchedViewShells> {
  const dir = typeof options.dir === "string" ? options.dir : fileURLToPath(options.dir);
  const manifestPath = join(dir, MANIFEST_FILE);
  const stamp = async () => {
    const info = await stat(manifestPath).catch(() => undefined);
    return info ? `${info.mtimeMs}:${info.size}` : undefined;
  };
  let current = await loadViewShells(options);
  let loadedStamp = await stamp();
  let refreshing: Promise<void> | undefined;

  const refresh = async () => {
    const now = await stamp();
    // A missing manifest means a rebuild is swapping directories; keep serving what is loaded.
    if (now === undefined || now === loadedStamp) return;
    try {
      current = await loadViewShells(options);
      loadedStamp = now;
    } catch {
      // A half-written build: the next render tries again.
    }
  };

  return {
    async render(view, boot) {
      refreshing ??= refresh().finally(() => {
        refreshing = undefined;
      });
      await refreshing;
      return current.render(view, boot);
    },
    get manifest() {
      return current.manifest;
    },
    get files() {
      return current.files;
    },
  };
}

/**
 * Serves the gallery `buildViews` writes (`gallery.html` and its preview pages) under `prefix`, straight from disk so a
 * rebuild shows at once. For development: it sets no cache headers and exposes sample data. Returns undefined for
 * paths it does not serve, so it composes with other handlers.
 */
export function serveGallery(
  dir: string | URL,
  { prefix = "/__gallery/" }: { prefix?: string } = {},
): (request: Request) => Promise<Response | undefined> {
  const root = typeof dir === "string" ? dir : fileURLToPath(dir);
  return async (request) => {
    if (request.method !== "GET") return undefined;
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(prefix)) return undefined;
    const rest = pathname.slice(prefix.length) || "gallery.html";
    if (!/^(?:gallery\.html|gallery\/[\w.-]+\.html)$/.test(rest)) return new Response("Not found", { status: 404 });
    try {
      return new Response(await readFile(join(root, rest)), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
}
