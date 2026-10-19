import { createRegistry, defineApp, op } from "@syrinx/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createOpenApiDocument } from "./index.js";

interface Node {
  name: string;
  children: Node[];
}
const Node: z.ZodType<Node> = z.object({
  name: z.string(),
  get children() {
    return z.array(Node);
  },
});

const tree = defineApp({
  name: "org-chart",
  version: "2.0.0",
  description: "Teams and reporting lines.",
  operations: {
    tree: op({
      description: "The whole org chart.",
      input: z.object({ depth: z.number().int().optional() }),
      output: Node,
      annotations: { readOnly: true },
      handler: () => ({ name: "root", children: [] }),
    }),
    rename: op({
      description: "Rename a team.",
      input: z.object({ name: z.string() }),
      output: z.object({ ok: z.boolean() }),
      visibility: ["rest"],
      handler: () => ({ ok: true }),
    }),
  },
});

const doc = createOpenApiDocument(createRegistry([tree]));
interface Op {
  operationId: string;
  parameters: { name: string; in: string }[];
  responses: Record<string, { content: Record<string, { schema: unknown }> }>;
}
const path = (p: string) => doc.paths[p] as Record<string, Op>;
const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas;

describe("createOpenApiDocument", () => {
  it("describes the API with info from a single app", () => {
    expect(doc).toMatchObject({
      openapi: "3.1.0",
      info: { title: "org-chart", version: "2.0.0", description: "Teams and reporting lines." },
      tags: [{ name: "org-chart" }],
    });
  });

  it("moves recursive schemas into components and rewrites their references", () => {
    const success = path("/api/org-chart/ops/tree").post?.responses["200"]?.content["application/json"]?.schema;
    expect(JSON.stringify(success)).toContain('"$ref":"#/components/schemas/OrgChartTreeOutput"');
    expect(schemas.OrgChartTreeOutput).toMatchObject({
      properties: { children: { items: { $ref: "#/components/schemas/OrgChartTreeOutput" } } },
    });
    expect(JSON.stringify(doc)).not.toMatch(/"\$ref":"#"|#\/\$defs\//);
  });

  it("adds GET with query parameters for read-only operations and Idempotency-Key for writes", () => {
    expect(path("/api/org-chart/ops/tree").get?.parameters).toEqual([
      expect.objectContaining({ name: "depth", in: "query", required: false }),
    ]);
    expect(path("/api/org-chart/ops/rename").get).toBeUndefined();
    expect(path("/api/org-chart/ops/rename").post?.parameters).toEqual([
      expect.objectContaining({ name: "Idempotency-Key", in: "header" }),
    ]);
  });

  it("documents input_required and a resume path only for operations that ask", () => {
    const asking = createOpenApiDocument(
      createRegistry([
        defineApp({
          name: "a",
          version: "1",
          description: "x",
          operations: {
            plain: op({
              description: "Plain.",
              input: z.object({}),
              output: z.object({}),
              visibility: ["rest"],
              handler: () => ({}),
            }),
            careful: op({
              description: "Careful.",
              input: z.object({}),
              output: z.object({}),
              visibility: ["rest"],
              confirm: () => "Sure?",
              handler: () => ({}),
            }),
          },
        }),
      ]),
    );
    const success = (p: string) => JSON.stringify((asking.paths[p] as Record<string, Op>).post?.responses["200"]);
    expect(success("/api/a/ops/plain")).not.toContain("InputRequired");
    expect(success("/api/a/ops/careful")).toContain("InputRequired");
    expect(Object.keys(asking.paths)).toEqual(["/api/a/ops/plain", "/api/a/ops/careful", "/api/a/ops/careful/resume"]);
  });

  it("gives every operation a unique operationId", () => {
    const ids = Object.values(doc.paths).flatMap((item) =>
      Object.values(item as Record<string, Op>).map((o) => o.operationId),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
