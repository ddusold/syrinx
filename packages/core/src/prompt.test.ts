import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRegistry, defineApp, lintApp, op, prompt, resource } from "./index.js";

const notes = defineApp({
  name: "notes",
  version: "1.0.0",
  description: "Personal notes.",
  operations: {
    read: op({
      description: "Read one note by its id.",
      input: z.object({ id: z.string().describe("Note id.") }),
      output: z.string(),
      annotations: { readOnly: true },
      handler: ({ id }) => `note ${id}`,
    }),
    write: op({
      description: "Write a note, replacing any existing text.",
      input: z.object({ id: z.string().describe("Note id."), text: z.string().describe("New text.") }),
      output: z.null(),
      visibility: ["rest"],
      permissions: ["notes:write"],
      handler: () => null,
    }),
  },
  resources: {
    note: resource({
      uri: "note://{id}",
      complete: { id: (value) => Array.from({ length: 150 }, (_, i) => `n${i}`).filter((id) => id.startsWith(value)) },
      description: "One note as plain text, by id.",
      output: z.string(),
      read: () => "",
    }),
  },
  prompts: {
    summarize: prompt({
      description: "Summarize a note in the requested tone.",
      args: z.object({
        id: z.string().describe("Note id."),
        tone: z.enum(["brief", "detailed"]).describe("How much detail."),
      }),
      permissions: (principal, { id }) => principal.id !== "blocked" || id !== "secret",
      render: ({ id, tone }) => [
        { role: "user", content: { type: "text", text: `Summarize note ${id}, ${tone}.` } },
        { role: "assistant", content: { type: "text", text: "Sure." } },
      ],
    }),
    daily: prompt({ description: "Plan the day from today's notes.", render: () => "Plan my day." }),
    focus: prompt({
      description: "Plan a focused session around one topic the user picks.",
      asks: true,
      render: async (_args, ctx) => {
        const answer = await ctx.ask("Which topic?", z.object({ topic: z.string() }), { key: "topic" });
        return `Plan a session on ${answer?.topic ?? "anything"}.`;
      },
    }),
    tagged: prompt({
      description: "Summarize the notes carrying one tag.",
      args: z.object({ tag: z.string().describe("Tag name.") }),
      permissions: ["notes:read"],
      complete: { tag: (value) => ["work", "home", "health"].filter((t) => t.startsWith(value)) },
      render: ({ tag }) => `Summarize notes tagged ${tag}.`,
    }),
  },
});

describe("prompts", () => {
  const registry = createRegistry([notes]);

  it("renders text as one user message, and passes messages through", async () => {
    expect(await registry.render("notes", "daily", undefined)).toEqual({
      resultType: "complete",
      data: {
        description: "Plan the day from today's notes.",
        messages: [{ role: "user", content: { type: "text", text: "Plan my day." } }],
      },
    });
    const rendered = await registry.render("notes", "summarize", { id: "n1", tone: "brief" });
    if (rendered.resultType !== "complete") throw new Error("expected messages");
    expect(rendered.data.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("validates arguments and checks permissions", async () => {
    await expect(registry.render("notes", "summarize", { id: "n1", tone: "loud" })).rejects.toMatchObject({
      kind: "validation",
      issues: [{ path: "tone" }],
    });
    await expect(
      registry.render(
        "notes",
        "summarize",
        { id: "secret", tone: "brief" },
        { principal: { id: "blocked", scopes: [] } },
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(registry.render("notes", "nope", {})).rejects.toMatchObject({ kind: "not_found" });
  });

  it("rejects prompt arguments that are not strings", () => {
    expect(() =>
      defineApp({
        ...notes,
        prompts: {
          bad: prompt({ description: "Takes a number.", args: z.object({ n: z.number() }), render: () => "" }),
        },
      }),
    ).toThrow(/args must be an object schema whose properties are all strings/);
  });
});

describe("asking prompts", () => {
  const registry = createRegistry([notes], { requestStateKey: "prompt-test-request-state-key-32-bytes" });

  it("asks, then renders with the answer on resume", async () => {
    const asked = await registry.render("notes", "focus", {});
    if (asked.resultType !== "input_required") throw new Error("expected a question");
    expect(asked.inputRequests).toMatchObject({ topic: { kind: "ask", message: "Which topic?" } });
    const done = await registry.render(
      "notes",
      "focus",
      {},
      {
        resume: {
          requestState: asked.requestState,
          inputResponses: { topic: { action: "accept", content: { topic: "taxes" } } },
        },
      },
    );
    expect(done).toMatchObject({ data: { messages: [{ content: { text: "Plan a session on taxes." } }] } });
  });

  it("will not resume an operation's state, and treats questions as declined when the caller cannot ask", async () => {
    const asked = await registry.render("notes", "focus", {});
    if (asked.resultType !== "input_required") throw new Error("expected a question");
    await expect(
      registry.invoke("notes", "read", {}, { resume: { requestState: asked.requestState, inputResponses: {} } }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(await registry.render("notes", "focus", {}, { canAsk: false })).toMatchObject({
      data: { messages: [{ content: { text: "Plan a session on anything." } }] },
    });
  });

  it("refuses to ask from prompts that do not declare asks", async () => {
    const quiet = defineApp({
      ...notes,
      prompts: {
        sneaky: prompt({
          description: "Asks without declaring it.",
          render: async (_a, ctx) => String(await ctx.confirm("Sure?")),
        }),
      },
    });
    await expect(createRegistry([quiet]).render("notes", "sneaky", {})).rejects.toMatchObject({ kind: "internal" });
  });
});

describe("completion", () => {
  const registry = createRegistry([notes]);
  const reader = { principal: { id: "r", scopes: ["notes:read"] } };

  it("suggests prompt arguments, checking the prompt's scopes", async () => {
    expect(await registry.complete({ app: "notes", prompt: "tagged", argument: "tag", value: "h" }, reader)).toEqual({
      values: ["home", "health"],
      total: 2,
      hasMore: false,
    });
    await expect(
      registry.complete({ app: "notes", prompt: "tagged", argument: "tag", value: "h" }),
    ).rejects.toMatchObject({ kind: "unauthenticated" });
  });

  it("caps suggestions at 100 and returns none for members without completers", async () => {
    const ids = await registry.complete({ app: "notes", resource: "note", argument: "id", value: "n" });
    expect([ids.values.length, ids.total, ids.hasMore]).toEqual([100, 150, true]);
    expect(await registry.complete({ app: "notes", prompt: "daily", argument: "x", value: "" })).toEqual({
      values: [],
      total: 0,
      hasMore: false,
    });
  });
});

describe("listing", () => {
  it("allows members by scope and tenant enablement, and reports when lists are personal", async () => {
    const registry = createRegistry([notes], { isEnabled: ({ prompt }, tenant) => prompt !== "daily" || !!tenant });
    expect(registry.personalized).toBe(true);
    expect(await registry.allows({ app: "notes", operation: "write" })).toBe(false);
    const writer = { id: "w", scopes: ["notes:write"] };
    expect(await registry.allows({ app: "notes", operation: "write" }, { principal: writer })).toBe(true);
    // Predicates need input, so they never hide a member from a listing.
    expect(
      await registry.allows({ app: "notes", prompt: "summarize" }, { principal: { id: "blocked", scopes: [] } }),
    ).toBe(true);
    expect(await registry.allows({ app: "notes", prompt: "daily" })).toBe(false);
    expect(await registry.allows({ app: "notes", prompt: "daily" }, { tenant: { id: "t" } })).toBe(true);
    expect(await registry.allows({ app: "notes", operation: "missing" })).toBe(false);
  });

  it("shares lists when nothing depends on the caller", () => {
    const open = defineApp({
      ...notes,
      operations: { read: notes.operations.read },
      prompts: { daily: notes.prompts.daily },
    });
    expect(createRegistry([open]).personalized).toBe(false);
  });
});

describe("lintApp", () => {
  it("accepts well-described apps", () => {
    expect(lintApp(notes)).toEqual([]);
  });

  it("flags short, long, duplicate and missing descriptions", () => {
    const sloppy = defineApp({
      name: "sloppy",
      version: "0.0.0",
      description: "Sloppy.",
      operations: {
        a: op({
          description: "Short.",
          input: z.object({ q: z.string() }),
          output: z.null(),
          annotations: { readOnly: true },
          handler: () => null,
        }),
        b: op({
          description: "x".repeat(1100),
          input: z.object({}),
          output: z.null(),
          annotations: { readOnly: true },
          mcp: { description: "Short." },
          handler: () => null,
        }),
      },
      resources: { r: resource({ uri: "s://r", output: z.null(), read: () => null }) },
    });
    expect(lintApp(sloppy).map((w) => `${w.target} ${w.message}`)).toEqual([
      "sloppy.a description is 6 characters; say what it does and when to use it.",
      "sloppy.a.q input field has no description.",
      "sloppy.b description is 6 characters; say what it does and when to use it.",
      "sloppy.b has the same description as sloppy.a; models cannot tell them apart.",
      "sloppy.r has no description.",
    ]);
  });
});
