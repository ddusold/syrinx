// The fixture app the official MCP conformance suite calls, written as an ordinary Syrinx app. Names and payloads are
// fixed by the suite's scenarios; `mcp` overrides carry the parts Syrinx would otherwise generate differently.
import { defineApp, op, prompt, resource, type ContentBlock, type Context } from "@syrinx/core";
import { z } from "zod";

/** A 1x1 red PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
/** Eight samples of 8-bit mono silence. */
const WAV = "UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==";

const none = z.object({});
const text = (value: string): ContentBlock => ({ type: "text", text: value });

/** A tool whose whole result is fixed content blocks. */
const fixed = (name: string, description: string, blocks: readonly ContentBlock[]) =>
  op({
    description,
    input: none,
    output: z.null(),
    annotations: { readOnly: true },
    mcp: { name, structured: false, content: () => blocks },
    handler: () => null,
  });

/** A tool that asks the user before answering; the answer text comes from `reply`. */
const asking = (name: string, description: string, run: (input: unknown, ctx: Context) => Promise<string>) =>
  op({
    description,
    input: none,
    output: z.string(),
    annotations: { readOnly: true, asks: true },
    mcp: { name, structured: false, content: (reply: string) => [text(reply)] },
    handler: run,
  });

const Name = z.object({ name: z.string() });

export const conformance = defineApp({
  name: "conformance",
  version: "0.0.0",
  description: "Fixtures for the official MCP conformance suite.",
  operations: {
    simpleText: fixed("test_simple_text", "Returns a fixed line of text for the conformance suite.", [
      text("This is a simple text response for testing."),
    ]),
    imageContent: fixed("test_image_content", "Returns a one-pixel PNG image as image content.", [
      { type: "image", data: PNG, mimeType: "image/png" },
    ]),
    audioContent: fixed("test_audio_content", "Returns a tiny WAV clip as audio content.", [
      { type: "audio", data: WAV, mimeType: "audio/wav" },
    ]),
    embeddedResource: fixed("test_embedded_resource", "Returns a text resource embedded in the result.", [
      {
        type: "resource",
        resource: {
          uri: "test://embedded-resource",
          mimeType: "text/plain",
          text: "This is an embedded resource content.",
        },
      },
    ]),
    multipleContentTypes: fixed("test_multiple_content_types", "Returns text, an image and a resource together.", [
      text("Multiple content types test:"),
      { type: "image", data: PNG, mimeType: "image/png" },
      {
        type: "resource",
        resource: {
          uri: "test://mixed-content-resource",
          mimeType: "application/json",
          text: JSON.stringify({ test: "data", value: 123 }),
        },
      },
    ]),
    errorHandling: op({
      description: "Always fails, so clients can check tool error reporting.",
      input: none,
      output: z.null(),
      annotations: { readOnly: true },
      mcp: { name: "test_error_handling", structured: false },
      handler: (_input, ctx) => {
        throw ctx.errors.conflict("This tool intentionally returns an error for testing");
      },
    }),
    // Progress needs a streamed response, which Syrinx does not send; the tool still completes.
    withProgress: fixed("test_tool_with_progress", "Completes after a short task (progress is not streamed).", [
      text("Progress tool finished."),
    ]),

    elicitation: asking(
      "test_input_required_result_elicitation",
      "Asks for the user's name, then greets them.",
      async (_input, ctx) => {
        const answer = await ctx.ask("What is your name?", Name, { key: "user_name" });
        return `Hello, ${answer?.name ?? "stranger"}!`;
      },
    ),
    requestState: asking(
      "test_input_required_result_request_state",
      "Asks for confirmation and reports that its request state came back intact.",
      async (_input, ctx) => {
        const answer = await ctx.ask("Please confirm", z.object({ ok: z.boolean() }), { key: "confirm" });
        return `state-ok: ${String(answer?.ok ?? false)}`;
      },
    ),
    multiRound: asking(
      "test_input_required_result_multi_round",
      "Asks two questions in two rounds, then summarizes the answers.",
      async (_input, ctx) => {
        const step1 = await ctx.ask("Step 1: What is your name?", Name, { key: "step1" });
        const step2 = await ctx.ask("Step 2: What is your favorite color?", z.object({ color: z.string() }), {
          key: "step2",
        });
        return `${step1?.name ?? "?"} likes ${step2?.color ?? "?"}.`;
      },
    ),
    capabilities: asking(
      "test_input_required_result_capabilities",
      "Asks for the user's name only when the client can answer elicitations.",
      async (_input, ctx) => {
        const answer = await ctx.ask("What is your name?", Name, { key: "user_name" });
        return `Hello, ${answer?.name ?? "stranger"}!`;
      },
    ),
    // Diagnostic tools the stateless-server scenario probes.
    missingCapability: asking(
      "test_missing_capability",
      "Needs elicitation, so clients that did not declare it get an error.",
      async (_input, ctx) => {
        const answer = await ctx.ask("What is your name?", Name, { key: "user_name" });
        return `Hello, ${answer?.name ?? "stranger"}!`;
      },
    ),
    streamingElicitation: asking(
      "test_streaming_elicitation",
      "Asks a question in-band; the server never sends requests of its own.",
      async (_input, ctx) => {
        const answer = await ctx.ask("What is your name?", Name, { key: "user_name" });
        return `Hello, ${answer?.name ?? "stranger"}!`;
      },
    ),
    logging: op({
      description: "Writes a server log line; nothing is sent to the client.",
      input: none,
      output: z.string(),
      annotations: { readOnly: true },
      mcp: { name: "test_logging_tool", structured: false, content: (reply: string) => [text(reply)] },
      handler: (_input, ctx) => {
        ctx.log.info("conformance logging tool called");
        return "Logged.";
      },
    }),
    tamperedState: asking(
      "test_input_required_result_tampered_state",
      "Asks for the user's name; a forged request state is rejected.",
      async (_input, ctx) => {
        const answer = await ctx.ask("What is your name?", Name, { key: "user_name" });
        return `Hello, ${answer?.name ?? "stranger"}!`;
      },
    ),
  },

  resources: {
    staticText: resource({
      uri: "test://static-text",
      description: "A fixed text resource for the conformance suite.",
      mimeType: "text/plain",
      output: z.string(),
      read: () => "This is the content of the static text resource.",
    }),
    staticBinary: resource({
      uri: "test://static-binary",
      description: "A fixed binary resource: a one-pixel PNG.",
      mimeType: "image/png",
      output: z.string(),
      read: () => PNG,
    }),
    templateData: resource({
      uri: "test://template/{id}/data",
      description: "Echoes its template parameter back as JSON.",
      output: z.object({ id: z.string(), templateTest: z.boolean(), data: z.string() }),
      read: ({ id }) => ({ id, templateTest: true, data: `Data for ID: ${id}` }),
    }),
  },

  prompts: {
    simple: prompt({
      description: "A prompt with no arguments for the conformance suite.",
      mcp: { name: "test_simple_prompt" },
      render: () => "This is a simple prompt for testing.",
    }),
    withArguments: prompt({
      description: "A prompt that echoes its two arguments.",
      mcp: { name: "test_prompt_with_arguments" },
      args: z.object({
        arg1: z.string().describe("First test argument"),
        arg2: z.string().describe("Second test argument"),
      }),
      complete: { arg1: (value) => ["paris", "park", "party"].filter((v) => v.startsWith(value)) },
      render: ({ arg1, arg2 }) => `Prompt with arguments: arg1='${arg1}', arg2='${arg2}'`,
    }),
    withEmbeddedResource: prompt({
      description: "A prompt that embeds the resource it is given.",
      mcp: { name: "test_prompt_with_embedded_resource" },
      args: z.object({ resourceUri: z.string().describe("URI of the resource to embed") }),
      render: ({ resourceUri }) => [
        {
          role: "user",
          content: {
            type: "resource",
            resource: { uri: resourceUri, mimeType: "text/plain", text: "Embedded resource content for testing." },
          },
        },
        { role: "user", content: text("Please process the embedded resource above.") },
      ],
    }),
    inputRequired: prompt({
      description: "Asks which context to use, then builds the prompt around it.",
      mcp: { name: "test_input_required_result_prompt" },
      asks: true,
      render: async (_args, ctx) => {
        const answer = await ctx.ask("What context should the prompt use?", z.object({ context: z.string() }), {
          key: "user_context",
        });
        return `Use this context: ${answer?.context ?? "none"}.`;
      },
    }),
    withImage: prompt({
      description: "A prompt that shows the model an image.",
      mcp: { name: "test_prompt_with_image" },
      render: () => [
        { role: "user", content: { type: "image", data: PNG, mimeType: "image/png" } },
        { role: "user", content: text("Please analyze the image above.") },
      ],
    }),
  },
});
