import type { App } from "./app.js";
import { toJsonSchema } from "./schema.js";

export interface LintWarning {
  /** `app.member`, or `app.member.field` for an input field. */
  target: string;
  message: string;
}

/** Below this, a description rarely tells a model when to pick the tool over its neighbours. */
const MIN_DESCRIPTION = 20;
/** Clients truncate or drop long descriptions, and every tool's description costs context on each request. */
const MAX_DESCRIPTION = 1024;

/**
 * Checks the descriptions models choose by: operations, prompts, resources and top-level input fields. Advisory only;
 * hosts log the warnings, and `syrinx check` can fail on them.
 */
export function lintApp(app: App): LintWarning[] {
  const warnings: LintWarning[] = [];
  const seen = new Map<string, string>();
  const describe = (target: string, description: string | undefined, required: boolean) => {
    const text = description?.trim() ?? "";
    if (!text) {
      if (required) warnings.push({ target, message: "has no description." });
      return;
    }
    if (text.length < MIN_DESCRIPTION) {
      warnings.push({
        target,
        message: `description is ${text.length} characters; say what it does and when to use it.`,
      });
    }
    if (text.length > MAX_DESCRIPTION) {
      warnings.push({ target, message: `description is ${text.length} characters; keep it under ${MAX_DESCRIPTION}.` });
    }
    const twin = seen.get(text);
    if (twin) warnings.push({ target, message: `has the same description as ${twin}; models cannot tell them apart.` });
    else seen.set(text, target);
  };
  const fields = (target: string, schema: Record<string, unknown>) => {
    const properties = (schema.properties ?? {}) as Record<string, { description?: string }>;
    for (const [name, property] of Object.entries(properties)) {
      if (!property.description?.trim()) {
        warnings.push({ target: `${target}.${name}`, message: "input field has no description." });
      }
    }
  };

  for (const [name, operation] of Object.entries(app.operations)) {
    const target = `${app.name}.${name}`;
    describe(target, operation.mcp?.description ?? operation.description, true);
    fields(target, toJsonSchema(operation.input, "input"));
  }
  for (const [name, p] of Object.entries(app.prompts)) {
    const target = `${app.name}.${name}`;
    describe(target, p.description, true);
    if (p.args) fields(target, toJsonSchema(p.args, "input"));
  }
  for (const [name, res] of Object.entries(app.resources)) describe(`${app.name}.${name}`, res.description, true);
  return warnings;
}
