/**
 * Guard against an ask that depends on findings the user never saw. The
 * failing shape: the agent works through tool calls, reasons in hidden
 * thinking, then calls ask with "Given those costs, ..." and no visible text.
 * Progress notes written earlier in the turn do not carry the findings, so the
 * ask call's own assistant message must say what the question depends on.
 */

import type { QuestionInput } from "../shared/ask-ui/types";

interface BranchEntry {
  type: string;
  message?: { role?: string; toolName?: string; content?: unknown };
}

/** The string bodies of every `type` block; plain string content is text. */
function blockBodies(content: unknown, type: "text" | "thinking"): string[] {
  if (typeof content === "string") {
    return type === "text" ? [content] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block: unknown) => {
    if (typeof block !== "object" || block === null) {
      return [];
    }
    const fields = block as Record<string, unknown>;
    const body = fields[type];
    return fields.type === type && typeof body === "string" ? [body] : [];
  });
}

function hasBlock(content: unknown, type: "text" | "thinking"): boolean {
  return blockBodies(content, type).some((body) => body.trim().length > 0);
}

const REFUSAL_PREFIX = "Error: ask refused: this reply has no visible text";

const NO_VISIBLE_CONTEXT_ERROR = `${REFUSAL_PREFIX}, so the user cannot see what the question depends on. The user cannot see your reasoning or tool results. In the same reply, before the ask call, write the findings, numbers, or tradeoffs the choice rests on, then call ask. Or put each option's detail in its preview.`;

// Session 01a1ca6f: without this hint the agent rewrote its explanation into
// thinking four times in a row and never emitted a text block.
const THINKING_ONLY_HINT =
  " Your explanation is in a thinking block, which the user never sees: write it as normal reply text, outside thinking.";

// Session 01a1ca6f also shows the hint alone may not break a loop, so a
// repeat refusal in the same turn tells the agent to leave the ask tool.
const REPEAT_REFUSAL_STOP =
  " This is a repeat refusal in this turn: do not call ask again. Write the question and its options as plain reply text and end your turn.";

function isRefusal({ message }: BranchEntry): boolean {
  return (
    message?.role === "toolResult" &&
    message.toolName === "ask" &&
    blockBodies(message.content, "text").some((text) =>
      text.startsWith(REFUSAL_PREFIX),
    )
  );
}

/** True when ask was already refused for missing context since the last user message. */
function refusedThisTurn(entries: readonly BranchEntry[]): boolean {
  const turnStart = entries.findLastIndex(
    (entry) => entry.message?.role === "user",
  );
  return entries.slice(turnStart + 1).some(isRefusal);
}

/**
 * The refusal for an ask that arrives with no visible context: its own
 * assistant message has no text and no option carries a preview. Undefined
 * when the ask may open.
 */
export function visibleContextError(
  questions: readonly QuestionInput[],
  entries: readonly BranchEntry[],
): string | undefined {
  const hasPreview = questions.some((question) =>
    question.options.some((option) => (option.preview ?? "").trim() !== ""),
  );
  if (hasPreview) {
    return undefined;
  }
  // Earlier tool calls in the same assistant message may already have results.
  const current = entries.findLast(
    (entry) => entry.type === "message" && entry.message?.role !== "toolResult",
  );
  if (current?.message?.role !== "assistant") {
    return undefined;
  }
  const { content } = current.message;
  if (hasBlock(content, "text")) {
    return undefined;
  }
  const thinkingHint = hasBlock(content, "thinking") ? THINKING_ONLY_HINT : "";
  const stop = refusedThisTurn(entries) ? REPEAT_REFUSAL_STOP : "";
  return NO_VISIBLE_CONTEXT_ERROR + thinkingHint + stop;
}
