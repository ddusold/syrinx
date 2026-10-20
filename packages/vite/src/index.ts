import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  /** Where bundles, `manifest.json` and the gallery go. Emptied first. */
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
}

export interface BuiltViews {
  manifest: ViewManifest;
  /** Gallery pages written, relative to `outDir`. */
  gallery: string[];
}

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
            `<iframe src="${escapeHtml(p.file)}" width="${w}" height="420" title="${escapeHtml(`${p.view} at ${w}px`)}"></iframe>`,
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
</style></head><body><h1>View gallery</h1>
${cards || "<p>No view declares examples yet.</p>"}
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

  await rm(outDir, { recursive: true, force: true });
  const manifest: ViewManifest = { version: 1, views: {} };
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
    manifest.views[id] = {
      js: entry.fileName,
      css: files.filter((f) => f.type === "asset" && f.fileName.endsWith(".css")).map((f) => f.fileName),
    };
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
  return { manifest, gallery };
}
