import type { StandardSchemaV1 } from "./standard-schema.js";

/** Stable error kinds. Each maps to one HTTP status and one problem type URI on every surface. */
export const errorKinds = {
  validation: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  cancelled: 499,
  upstream: 502,
  internal: 500,
} as const;

export type ErrorKind = keyof typeof errorKinds;

export interface FieldIssue {
  path: string;
  message: string;
}

export class SyrinxError extends Error {
  readonly kind: ErrorKind;
  readonly issues: readonly FieldIssue[];

  constructor(kind: ErrorKind, message: string, issues: readonly FieldIssue[] = []) {
    super(message);
    this.name = "SyrinxError";
    this.kind = kind;
    this.issues = issues;
  }

  get status(): number {
    return errorKinds[this.kind];
  }
}

export const errors = {
  validation: (message: string, issues: readonly FieldIssue[] = []) => new SyrinxError("validation", message, issues),
  forbidden: (message = "Forbidden") => new SyrinxError("forbidden", message),
  notFound: (message = "Not found") => new SyrinxError("not_found", message),
  conflict: (message = "Conflict") => new SyrinxError("conflict", message),
  cancelled: (message = "Cancelled") => new SyrinxError("cancelled", message),
  upstream: (message = "Upstream failure") => new SyrinxError("upstream", message),
};

export function toFieldIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): FieldIssue[] {
  return issues.map((issue) => ({
    path: (issue.path ?? []).map((seg) => String(typeof seg === "object" ? seg.key : seg)).join("."),
    message: issue.message,
  }));
}
