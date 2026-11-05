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
  message?: { role?: string; content?: unknown };
}

function hasVisibleText(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  return (
    Array.isArray(content) &&
    content.some(
      (block: unknown) =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string" &&
        block.text.trim().length > 0,
    )
  );
}

/**
 * True when the ask arrives with no visible context: its own assistant message
 * has no text and no option carries a preview.
 */
export function lacksVisibleContext(
  questions: readonly QuestionInput[],
  entries: readonly BranchEntry[],
): boolean {
  const hasPreview = questions.some((question) =>
    question.options.some((option) => (option.preview ?? "").trim() !== ""),
  );
  if (hasPreview) {
    return false;
  }
  // Earlier tool calls in the same assistant message may already have results.
  const current = entries.findLast(
    (entry) => entry.type === "message" && entry.message?.role !== "toolResult",
  );
  if (current?.message?.role !== "assistant") {
    return false;
  }
  return !hasVisibleText(current.message.content);
}

export const NO_VISIBLE_CONTEXT_ERROR =
  "Error: ask refused: this reply has no visible text, so the user cannot see what the question depends on. The user cannot see your reasoning or tool results. In the same reply, before the ask call, write the findings, numbers, or tradeoffs the choice rests on, then call ask. Or put each option's detail in its preview.";
