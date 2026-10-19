import { seal, sealingKey, unseal, type Secret } from "./crypto.js";
import { errors, SyrinxError, toFieldIssues } from "./errors.js";
import { toJsonSchema, type JsonSchema, type Schema } from "./schema.js";
import type { StandardSchemaV1 } from "./standard-schema.js";

/** A question an operation asks before it can finish. Surfaces render it: MCP as an elicitation, REST in the envelope. */
export type InputRequest = { kind: "confirm"; message: string } | { kind: "ask"; message: string; schema: JsonSchema };

/** The caller's answer, shaped like an MCP elicitation result so every surface passes it through unchanged. */
export interface InputResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/** What an operation returns when it needs input: the questions, plus state the caller echoes back on the retry. */
export interface InputRequired {
  resultType: "input_required";
  inputRequests: Record<string, InputRequest>;
  requestState: string;
}

/** Answers to a previous `input_required` result, sent with the retried call. */
export interface Resume {
  requestState: string;
  inputResponses: Record<string, unknown>;
}

/** What a request state is bound to. A state minted for one binding is rejected under any other. */
export interface Binding {
  app: string;
  operation: string;
  principal: string;
  tenant: string | undefined;
  inputHash: string;
}

interface Answer {
  message: string;
  response: InputResponse;
}

interface StatePayload {
  v: 1;
  exp: number;
  binding: Binding;
  /** Shared by every round of one call, so audit records can be grouped. */
  interactionId: string;
  answers: Answer[];
  pending: { key: string; message: string };
}

/** Thrown by ctx.confirm / ctx.ask when the answer is not known yet; the pipeline turns it into `input_required`. */
export class InputRequiredSignal extends Error {
  constructor(
    readonly key: string,
    readonly request: InputRequest,
  ) {
    super(`Input required: ${request.message}`);
    this.name = "InputRequiredSignal";
  }
}

export interface RequestStateCodec {
  mint(binding: Binding, interactionId: string, answers: Answer[], pending: StatePayload["pending"]): Promise<string>;
  /** The answers so far, including the response to the pending question. Throws a validation error on any mismatch. */
  open(binding: Binding, resume: Resume): Promise<{ interactionId: string; answers: Answer[] }>;
}

/**
 * Request state is encrypted (AES-256-GCM), not just signed: clients cannot read the answers, principal or tenant
 * it carries, nor change them. Pass several secrets to rotate: the first seals new state, any of them opens it.
 */
export function createRequestStateCodec(secrets: Secret | readonly Secret[], ttlSeconds = 600): RequestStateCodec {
  const list = typeof secrets === "string" || secrets instanceof Uint8Array ? [secrets] : secrets;
  if (list.length === 0) throw new RangeError("requestStateKey needs at least one key.");
  const keys = Promise.all(list.map(sealingKey));
  const invalid = (why: string) => errors.validation(`requestState ${why}; start the call again without it.`);

  return {
    async mint(binding, interactionId, answers, pending) {
      const exp = Date.now() + ttlSeconds * 1000;
      const payload: StatePayload = { v: 1, exp, binding, interactionId, answers, pending };
      const [current] = await keys;
      if (!current) throw new SyrinxError("internal", "requestStateKey needs at least one key.");
      return seal(current, payload);
    },

    async open(binding, resume) {
      const payload = (await unseal(await keys, resume.requestState)) as StatePayload | undefined;
      if (payload?.v !== 1) throw invalid("is not valid");
      if (payload.exp < Date.now()) throw invalid("has expired");
      const b = payload.binding;
      if (
        b.app !== binding.app ||
        b.operation !== binding.operation ||
        b.principal !== binding.principal ||
        b.tenant !== binding.tenant ||
        b.inputHash !== binding.inputHash
      ) {
        throw invalid("belongs to a different call");
      }
      const response = parseResponse(resume.inputResponses[payload.pending.key]);
      if (!response) throw errors.validation(`Missing or malformed input response "${payload.pending.key}".`);
      return {
        interactionId: payload.interactionId,
        answers: [...payload.answers, { message: payload.pending.message, response }],
      };
    },
  };
}

function parseResponse(value: unknown): InputResponse | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { action, content } = value as Record<string, unknown>;
  if (action !== "accept" && action !== "decline" && action !== "cancel") return undefined;
  if (content !== undefined && (typeof content !== "object" || content === null || Array.isArray(content))) {
    return undefined;
  }
  return content === undefined ? { action } : { action, content: content as Record<string, unknown> };
}

/**
 * Replays recorded answers in call order. The handler re-runs from the top on every round, so the n-th ask returns
 * the n-th answer; a question that changed since it was answered is asked again.
 */
export function createAsker(answers: Answer[]) {
  let index = 0;

  const next = (request: InputRequest): InputResponse => {
    const i = index++;
    const recorded = answers[i];
    if (recorded?.message === request.message) return recorded.response;
    answers.length = i; // drop this answer and every later one
    throw new InputRequiredSignal(`input-${i}`, request);
  };

  return {
    answers,
    confirm(message: string): Promise<boolean> {
      return Promise.resolve(next({ kind: "confirm", message }).action === "accept");
    },
    async ask<S extends Schema>(message: string, schema: S): Promise<StandardSchemaV1.InferOutput<S> | undefined> {
      const response = next({ kind: "ask", message, schema: toJsonSchema(schema, "input") });
      if (response.action !== "accept") return undefined;
      const parsed = await schema["~standard"].validate(response.content ?? {});
      if (parsed.issues) throw errors.validation("Input response failed validation.", toFieldIssues(parsed.issues));
      return parsed.value;
    },
  };
}
