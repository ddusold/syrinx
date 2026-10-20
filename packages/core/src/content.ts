/**
 * Content a surface can show besides structured data: prompt messages, and tool results that override their default
 * rendering. The shapes match MCP content blocks so the MCP surface passes them through unchanged.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string } & ({ text: string } | { blob: string }) };

export interface PromptMessage {
  role: "user" | "assistant";
  content: ContentBlock;
}

/** What a prompt's render returns: plain text (one user message), or the messages themselves. */
export type PromptContent = string | readonly PromptMessage[];

/** A rendered prompt, normalized to messages. */
export interface RenderedPrompt {
  description: string;
  messages: PromptMessage[];
}

export function toMessages(content: PromptContent): PromptMessage[] {
  return typeof content === "string" ? [{ role: "user", content: { type: "text", text: content } }] : [...content];
}
