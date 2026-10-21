import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  createRegistry,
  defineApp,
  op,
  schemaVersion,
  view,
  viewClosure,
  viewId,
  type View,
  type ViewData,
} from "./index.js";

const entry = new URL("./views/Card.vue", import.meta.url);
const Item = z.object({ id: z.string(), name: z.string() });

const read = op({
  description: "Read one item by id.",
  input: z.object({ id: z.string() }),
  output: Item,
  annotations: { readOnly: true },
  handler: ({ id }) => ({ id, name: "x" }),
});
const list = op({
  description: "List every item.",
  input: z.object({}),
  output: z.object({ items: z.array(Item) }),
  annotations: { readOnly: true },
  handler: () => ({ items: [] }),
});
const rename = op({
  description: "Rename an item.",
  input: z.object({ id: z.string(), name: z.string() }),
  output: Item,
  visibility: ["model", "app"],
  handler: (input) => input,
});
const purge = op({
  description: "Delete every item.",
  input: z.object({}),
  output: z.object({}),
  visibility: ["model"],
  handler: () => ({}),
});

const people = defineApp({
  name: "people",
  version: "1.0.0",
  description: "People.",
  operations: { read },
  views: { badge: view({ entry, boundTo: ["read"] }) },
});

describe("view", () => {
  it("stamps views with their app and name and fills defaults", () => {
    expect(people.views.badge).toMatchObject({
      kind: "view",
      app: "people",
      name: "badge",
      boundTo: ["read"],
      calls: [],
      embeds: [],
      features: {},
    });
    expect(Object.isFrozen(people.views.badge)).toBe(true);
  });

  it("resolves embeds across apps and within one app, and walks the closure", () => {
    const row = view({ entry, calls: ["rename"] });
    const items = defineApp({
      name: "items",
      version: "1.0.0",
      description: "Items.",
      operations: { read, list, rename },
      views: {
        row,
        browser: view({
          entry,
          boundTo: ["list", { op: "read", component: "detail" }],
          embeds: [row, people.views.badge],
        }),
      },
    });
    expect(items.views.browser.embeds.map((v) => `${v.app}/${v.name}`)).toEqual(["items/row", "people/badge"]);
    expect(viewClosure(items.views.browser).map((v) => v.name)).toEqual(["browser", "row", "badge"]);
    expect(() => createRegistry([items])).toThrow(/embeds "people.badge", whose app is not registered/);
    expect(() => createRegistry([people, items])).not.toThrow();
  });

  it("lets two apps' views navigate to each other, bundling both ways, which embedding would not allow", () => {
    const later: { projects?: View } = {};
    const tasks = defineApp({
      name: "tasks",
      version: "1.0.0",
      description: "Tasks.",
      operations: { read },
      // The other app does not exist yet when this one is declared, so the link is a function.
      views: { main: view({ entry, boundTo: ["read"], navigatesTo: () => (later.projects ? [later.projects] : []) }) },
    });
    const projects = defineApp({
      name: "projects",
      version: "1.0.0",
      description: "Projects.",
      operations: { read },
      views: { main: view({ entry, boundTo: ["read"], navigatesTo: () => [tasks.views.main] }) },
    });
    later.projects = projects.views.main;
    expect(viewClosure(tasks.views.main).map(viewId)).toEqual(["tasks/main", "projects/main"]);
    expect(viewClosure(projects.views.main).map(viewId)).toEqual(["projects/main", "tasks/main"]);
    expect(() => createRegistry([tasks, projects])).not.toThrow();
    expect(() => createRegistry([tasks])).toThrow(/navigates to "projects.main", whose app is not registered/);
  });

  it("types the data as the output of the bound operations", () => {
    const _items = defineApp({
      name: "items",
      version: "1.0.0",
      description: "Items.",
      operations: { read, list, rename },
      views: { browser: view({ entry, boundTo: ["list", { op: "read", component: "detail" }], calls: ["rename"] }) },
    });
    expectTypeOf<ViewData<typeof _items, "browser">>().toEqualTypeOf<
      { id: string; name: string } | { items: { id: string; name: string }[] }
    >();
  });

  const define = (views: Record<string, ReturnType<typeof view>>) =>
    defineApp({
      name: "items",
      version: "1.0.0",
      description: "Items.",
      operations: { read, list, rename, purge },
      views,
    });

  it("rejects bindings and calls to operations it cannot reach", () => {
    expect(() => define({ card: view({ entry, boundTo: ["nope" as "read"] }) })).toThrow(/unknown operation "nope"/);
    expect(() => define({ card: view({ entry, calls: ["purge"] }) })).toThrow(/not visible on the "app" surface/);
    expect(() => define({ a: view({ entry, boundTo: ["read"] }), b: view({ entry, boundTo: ["read"] }) })).toThrow(
      /bound to both views "a" and "b"/,
    );
    expect(() => define({ Card: view({ entry }) })).toThrow(/camelCase/);
  });

  it("rejects embeds that loop or belong to no app", () => {
    const loose = view({ entry });
    expect(() => define({ card: view({ entry, embeds: [loose] }) })).toThrow(/belongs to no app/);
    const a: { entry: URL; embeds: object[] } = { entry, embeds: [] };
    const b = { entry, embeds: [a] };
    a.embeds.push(b);
    expect(() => define({ a, b } as never)).toThrow(/cycle/);
  });

  it("fingerprints output schemas", async () => {
    expect(await schemaVersion(read)).toMatch(/^[\w-]{12}$/);
    expect(await schemaVersion(read)).toBe(await schemaVersion(rename));
    expect(await schemaVersion(read)).not.toBe(await schemaVersion(list));
  });
});
