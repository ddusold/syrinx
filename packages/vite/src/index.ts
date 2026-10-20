import { watch as watchFiles } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { bindingComponent, bindingOp, viewClosure, viewId, type App, type View, type ViewBoot } from "@syrinx/core";
import { loadViewShells, MANIFEST_FILE, type ViewManifest } from "@syrinx/ui/server";
import { build, mergeConfig, type InlineConfig, type Plugin, type PluginOption, type Rollup } from "vite";

/** How view files of one kind become view modules: `.vue` files go through `@syrinx/ui-vue`'s `toView`. */
export interface ViewAdapter {
  test: RegExp;
  /** The module exporting the adapter function. */
  from: string;
  /** The adapter's export name; it takes the file's default export and returns a view module. */
  name: string;
}

/** Files no adapter matches must default-export a view module (`{ mount(el, props) }`). */
export const defaultAdapters: readonly ViewAdapter[] = [{ test: /\.vue$/, from: "@syrinx/ui-vue", name: "toView" }];

export interface BuildViewsOptions {
  apps: readonly App[];
  /**
   * Where bundles, `manifest.json` and the gallery go. A build runs in a sibling directory and replaces this one only
   * when it succeeds, so a failed build leaves the last good views, and a server reading them never sees half a build.
   */
  outDir: string;
  /** Resolves string entries and node modules. Defaults to the current directory. */
  root?: string;
  /** Framework plugins, such as `vue()` from `@vitejs/plugin-vue`. */
  plugins?: PluginOption[];
  adapters?: readonly ViewAdapter[];
  /** Writes `gallery.html` and a preview page per view example. Defaults to true. */
  gallery?: boolean;
  /** Merged into every build, for aliases, defines and the like. */
  vite?: InlineConfig;
  /**
   * Size limits per view bundle (script plus styles). Going over one adds a warning to {@link BuiltViews.warnings}.
   * Shells travel inside `resources/read` results, often inline, so size is paid on every view open. The default is a
   * guideline of 512 KB, not a host limit; pass `false` to turn the check off.
   */
  budget?: false | { bytes?: number; gzipBytes?: number };
}

/** What one view bundle weighs, in bytes. `gzip` is what travels when the server compresses (it does by default). */
export interface ViewSize {
  js: number;
  css: number;
  total: number;
  gzip: number;
}

const DEFAULT_BUDGET: { bytes?: number; gzipBytes?: number } = { bytes: 512 * 1024 };

export interface BuiltViews {
  manifest: ViewManifest;
  /** Gallery pages written, relative to `outDir`. */
  gallery: string[];
  /** Keyed `app/view`. */
  sizes: Record<string, ViewSize>;
  /** Problems worth a look that did not fail the build, such as a bundle over its budget. */
  warnings: string[];
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

const VIRTUAL = "virtual:syrinx-view/";
const slug = (id: string) => id.replace("/", "-");

const entryPath = ({ entry }: View, root: string) =>
  entry instanceof URL || entry.startsWith("file:") ? fileURLToPath(entry) : resolve(root, entry);

/** The bundle entry for one root view: import it and its embeds, adapt each, start the runtime. */
function entryModule(root: View, projectRoot: string, adapters: readonly ViewAdapter[]): string {
  const imports: string[] = [`import { startView } from "@syrinx/ui";`];
  const adapterNames = new Map<ViewAdapter, string>();
  const entries: string[] = [];
  viewClosure(root).forEach((v, i) => {
    const file = entryPath(v, projectRoot);
    imports.push(`import m${i} from ${JSON.stringify(file)};`);
    const adapter = adapters.find((a) => a.test.test(file));
    let expr = `m${i}`;
    if (adapter) {
      let local = adapterNames.get(adapter);
      if (!local) {
        local = `adapt${adapterNames.size}`;
        adapterNames.set(adapter, local);
        imports.push(`import { ${adapter.name} as ${local} } from ${JSON.stringify(adapter.from)};`);
      }
      expr = `${local}(m${i})`;
    }
    entries.push(`  ${JSON.stringify(viewId(v))}: ${expr},`);
  });
  return [
    ...imports,
    `startView({ views: {`,
    ...entries,
    `} }).catch((error) => {`,
    `  console.error("[syrinx] the view failed to start", error);`,
    `  document.body.textContent = "This view failed to start.";`,
    `});`,
  ].join("\n");
}

function entryPlugin(views: Map<string, View>, root: string, adapters: readonly ViewAdapter[]): Plugin {
  return {
    name: "syrinx:view-entry",
    resolveId: (id) => (id.startsWith(VIRTUAL) ? `\0${id}` : undefined),
    load(id) {
      if (!id.startsWith(`\0${VIRTUAL}`)) return undefined;
      const v = views.get(id.slice(VIRTUAL.length + 1));
      return v ? entryModule(v, root, adapters) : undefined;
    },
  };
}

const outputs = (result: Awaited<ReturnType<typeof build>>): Rollup.RollupOutput[] =>
  Array.isArray(result) ? result : "output" in result ? [result] : [];

/** Boot data for a gallery page: the sample data, no operations (the preview bridge refuses calls). */
function previewBoot(v: View, example: NonNullable<View["examples"]>[number]): ViewBoot {
  const binding = v.boundTo.find((b) => bindingComponent(b) === example.component) ?? v.boundTo[0];
  return {
    view: viewId(v),
    channel: "preview",
    operations: {},
    features: Object.fromEntries(viewClosure(v).map((c) => [viewId(c), c.features])),
    preview: {
      data: example.data,
      ...(binding ? { op: bindingOp(binding) } : {}),
      ...(example.component ? { component: example.component } : {}),
    },
  };
}

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

function galleryIndex(pages: { title: string; view: string; file: string }[]): string {
  const cards = pages
    .map(
      (p) => `<figure><figcaption><strong>${escapeHtml(p.view)}</strong> · ${escapeHtml(p.title)}</figcaption>
<div class="widths">${[360, 768]
        .map(
          (w) =>
            `<iframe data-src="${escapeHtml(p.file)}" src="${escapeHtml(p.file)}" width="${w}" height="420" title="${escapeHtml(`${p.view} at ${w}px`)}"></iframe>`,
        )
        .join("")}</div></figure>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>View gallery</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:16px;background:#f6f6f4;color:#1f1f1d}
h1{font-size:20px;margin:0 0 16px}figure{margin:0 0 24px}figcaption{margin-bottom:8px}
.widths{display:flex;gap:16px;overflow-x:auto}iframe{border:1px solid #d8d6d0;border-radius:8px;background:#fff;flex:none}
@media (prefers-color-scheme: dark){body{background:#1b1b1a;color:#ecebe7}iframe{border-color:#3a3936;background:#111}}
.bar{display:flex;align-items:center;gap:8px;margin:0 0 16px}select{font:inherit}
</style></head><body><h1>View gallery</h1>
<div class="bar"><label for="theme">Theme</label><select id="theme"><option value="">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
${cards || "<p>No view declares examples yet.</p>"}
<script>
// The preview pages read ?theme= (see createPreviewBridge); reload each frame with the chosen one.
const theme = document.getElementById("theme");
const apply = () => {
  for (const frame of document.querySelectorAll("iframe[data-src]")) {
    frame.src = theme.value ? frame.dataset.src + "?theme=" + theme.value : frame.dataset.src;
  }
  try { sessionStorage.setItem("syrinx-gallery-theme", theme.value); } catch {}
};
try { theme.value = sessionStorage.getItem("syrinx-gallery-theme") || ""; } catch {}
theme.addEventListener("change", apply);
if (theme.value) apply();
</script>
</body></html>`;
}

/**
 * Builds every view of the given apps. Each root view becomes one self-contained script (with the views it embeds)
 * and at most one stylesheet, named by content hash, so a shell can inline it or a server can cache it forever.
 */
export async function buildViews(options: BuildViewsOptions): Promise<BuiltViews> {
  const root = options.root ?? process.cwd();
  const outDir = resolve(root, options.outDir);
  const adapters = options.adapters ?? defaultAdapters;
  const views = new Map<string, View>();
  for (const app of options.apps) for (const v of Object.values(app.views)) views.set(viewId(v), v);

  const stage = `${outDir}.building`;
  await rm(stage, { recursive: true, force: true });
  try {
    const built = await buildInto(stage);
    await rm(outDir, { recursive: true, force: true });
    await rename(stage, outDir);
    return built;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }

  async function buildInto(outDir: string): Promise<BuiltViews> {
    const manifest: ViewManifest = { version: 1, views: {} };
    const sizes: Record<string, ViewSize> = {};
    const warnings: string[] = [];
    const budget = options.budget ?? DEFAULT_BUDGET;
    for (const id of views.keys()) {
      const config: InlineConfig = {
        configFile: false,
        root,
        logLevel: "warn",
        plugins: [entryPlugin(views, root, adapters), ...(options.plugins ?? [])],
        build: {
          outDir,
          emptyOutDir: false,
          target: "es2022",
          cssCodeSplit: false,
          modulePreload: false,
          copyPublicDir: false,
          rollupOptions: {
            input: `${VIRTUAL}${id}`,
            // Dependencies' misplaced /*#__PURE__*/ comments are harmless and would bury real warnings.
            onwarn: (warning, warn) => {
              if (warning.code !== "INVALID_ANNOTATION") warn(warning);
            },
            output: {
              entryFileNames: `assets/${slug(id)}-[hash].js`,
              assetFileNames: `assets/${slug(id)}-[hash][extname]`,
              inlineDynamicImports: true,
            },
          },
        },
      };
      const result = await build(options.vite ? mergeConfig(config, options.vite) : config);
      const files = outputs(result).flatMap((o) => o.output);
      const entry = files.find((f): f is Rollup.OutputChunk => f.type === "chunk" && f.isEntry);
      if (!entry) throw new Error(`Building view ${id} produced no script.`);
      const styles = files.filter((f): f is Rollup.OutputAsset => f.type === "asset" && f.fileName.endsWith(".css"));
      manifest.views[id] = { js: entry.fileName, css: styles.map((f) => f.fileName) };
      const js = Buffer.from(entry.code);
      const css = Buffer.concat(styles.map((f) => Buffer.from(f.source)));
      sizes[id] = {
        js: js.length,
        css: css.length,
        total: js.length + css.length,
        gzip: gzipSync(Buffer.concat([js, css])).length,
      };
      if (budget) {
        const size = sizes[id];
        if (budget.bytes !== undefined && size.total > budget.bytes) {
          warnings.push(
            `View ${id} is ${kb(size.total)}, over its ${kb(budget.bytes)} budget; its shell travels with every open.`,
          );
        }
        if (budget.gzipBytes !== undefined && size.gzip > budget.gzipBytes) {
          warnings.push(`View ${id} is ${kb(size.gzip)} gzipped, over its ${kb(budget.gzipBytes)} budget.`);
        }
      }
    }
    await writeFile(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

    const gallery: string[] = [];
    if (options.gallery !== false) {
      const shells = await loadViewShells({ dir: outDir });
      const pages: { title: string; view: string; file: string }[] = [];
      for (const [id, v] of views) {
        for (const [i, example] of (v.examples ?? []).entries()) {
          const file = `gallery/${slug(id)}-${i}.html`;
          const { html } = shells.render(v, previewBoot(v, example));
          await mkdir(dirname(join(outDir, file)), { recursive: true });
          await writeFile(join(outDir, file), html);
          pages.push({ title: example.title, view: id, file });
          gallery.push(file);
        }
      }
      await writeFile(join(outDir, "gallery.html"), galleryIndex(pages));
      gallery.push("gallery.html");
    }
    return { manifest, gallery, sizes, warnings };
  }
}

export interface WatchViewsOptions extends BuildViewsOptions {
  /** Called after every build, including the first, with its result or the error that failed it. */
  onBuild?: (result: { built: BuiltViews } | { error: unknown }) => void;
  /** Milliseconds to wait for edits to settle before rebuilding. Defaults to 150. */
  debounceMs?: number;
}

/**
 * Builds the views, then rebuilds whenever a view's source directory changes. A failed rebuild keeps the last good
 * views (see {@link BuildViewsOptions.outDir}). Pair with `watchViewShells` from `@syrinx/ui/server` to serve them
 * without restarting.
 */
export async function watchViews(options: WatchViewsOptions): Promise<{ close(): void }> {
  const root = options.root ?? process.cwd();
  const dirs = new Set<string>();
  for (const app of options.apps) for (const v of Object.values(app.views)) dirs.add(dirname(entryPath(v, root)));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = Promise.resolve();
  let queued = false;
  const rebuild = () => {
    // One build at a time; edits during a build queue exactly one more.
    if (queued) return;
    queued = true;
    running = running.then(async () => {
      queued = false;
      try {
        options.onBuild?.({ built: await buildViews(options) });
      } catch (error) {
        options.onBuild?.({ error });
      }
    });
  };
  const watchers = [...dirs].map((dir) =>
    watchFiles(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(rebuild, options.debounceMs ?? 150);
    }),
  );
  rebuild();
  await running;
  return {
    close() {
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
