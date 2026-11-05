/**
 * Guard against ask options that point at numbered items the user never saw,
 * such as "1 + 2 (recommended)" or "All four" when the four parts were only
 * enumerated in the model's hidden reasoning.
 */

import type { QuestionInput } from "../shared/ask-ui/types";

const WORD_COUNTS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

const COMBINED_NUMBERS_REGEX =
  /^\s*\d+(?:(?:\s*[+&]\s*|,\s+|\s+and\s+)\d+)+(?!\d)(?!\s*(?:[%x×:]|px|ms|s\b|min|h\b|kb|mb|gb|kib|mib|gib))/i;
const SINGLE_ONLY_REGEX = /^\s*(\d+)\s+only\b/i;
const NAMED_ITEM_REGEX =
  /\b(?:option|item|part|issue|fix|finding)s?\s+(\d+(?:(?:\s*[+&,]\s*|\s+and\s+)\d+)*)\b/gi;
// "All four" or "All 5 (recommended)", but not "All three meeting areas".
const ALL_COUNT_REGEX =
  /\ball\s+(two|three|four|five|six|seven|eight|nine|[2-9])(?=\s*(?:$|[(,;:—–-]|incl))/i;

function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

// Words that carry no description of the choice itself.
const FILLER_REGEX =
  /\b(?:recommend(?:ed)?|only|and|both|all|the|then|plus|now|first|them|these|those|items?|parts?|options?|fix(?:es)?|issues?|findings?)\b/gi;

/**
 * Item numbers a bare option label refers to. A label is bare when nothing
 * but number references and filler remains, such as "1 + 2 (recommended)",
 * "2 only", or "All four". A label that also names its choice, such as
 * "RPC-only fix (option 1)", is self-describing and returns [].
 */
export function referencedItemNumbers(label: string): number[] {
  const found = new Set<number>();
  let rest = label;
  const take = (match: string, values: number[]) => {
    rest = rest.replace(match, " ");
    for (const value of values) {
      found.add(value);
    }
  };
  const combined = label.match(COMBINED_NUMBERS_REGEX);
  if (combined) {
    take(combined[0], numbersIn(combined[0]));
  }
  const single = label.match(SINGLE_ONLY_REGEX);
  if (single) {
    take(single[0], [Number(single[1])]);
  }
  for (const match of label.matchAll(NAMED_ITEM_REGEX)) {
    take(match[0], numbersIn(match[1] ?? ""));
  }
  const all = label.match(ALL_COUNT_REGEX);
  if (all) {
    const word = (all[1] ?? "").toLowerCase();
    const count = WORD_COUNTS[word] ?? Number(word);
    take(
      all[0],
      Array.from({ length: count }, (_, index) => index + 1),
    );
  }
  if (/\p{L}{2,}/u.test(rest.replace(FILLER_REGEX, " "))) {
    return [];
  }
  return [...found].filter((value) => value >= 1 && value <= 20);
}

function definesItem(text: string, value: number): boolean {
  // A list marker or labelled heading at line start, for example "1.", "2)",
  // "(3)", "- **Option 4** —", "### Part 1:", "Fix 2 -", or a table row
  // "| 1 | Change |".
  const marker = new RegExp(
    `^[ \\t>]*(?:[-*+][ \\t]+)?(?:#{1,6}[ \\t]+)?(?:\\*\\*|__)?(?:(?:option|item|part|issue|fix|finding|step)[ \\t]+)?\\(?${value}(?:[.):]|\\*\\*|__|[ \\t]+[-—–])`,
    "im",
  );
  const tableRow = new RegExp(`^[ \\t]*\\|[ \\t]*#?${value}[ \\t]*\\|`, "m");
  return marker.test(text) || tableRow.test(text);
}

export interface UndefinedItemReference {
  path: string;
  label: string;
  missing: number[];
}

/**
 * Return option labels whose numbered references are not defined in the
 * visible conversation or in the ask payload itself.
 */
export function findUndefinedItemReferences(
  questions: readonly QuestionInput[],
  visibleText: string,
): UndefinedItemReference[] {
  const payloadText = questions
    .flatMap((question) => [
      question.prompt,
      ...question.options.flatMap((option) => [
        option.description ?? "",
        option.preview ?? "",
      ]),
    ])
    .join("\n");
  const context = `${visibleText}\n${payloadText}`;
  const problems: UndefinedItemReference[] = [];
  for (const [questionIndex, question] of questions.entries()) {
    for (const [optionIndex, option] of question.options.entries()) {
      const missing = referencedItemNumbers(option.label).filter(
        (value) => !definesItem(context, value),
      );
      if (missing.length > 0) {
        problems.push({
          path: `questions[${questionIndex}].options[${optionIndex}].label`,
          label: option.label,
          missing,
        });
      }
    }
  }
  return problems;
}

interface BranchEntry {
  type: string;
  display?: boolean;
  content?: unknown;
  message?: { role?: string; content?: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Text the user has actually seen: user and assistant text blocks, plus
 * extension messages shown in the transcript (such as a review report).
 * Thinking and tool results are excluded; the user does not reliably read them.
 */
export function visibleConversationText(
  entries: readonly BranchEntry[],
): string {
  return entries
    .map((entry) => {
      if (entry.type === "custom_message") {
        return entry.display === true ? textOf(entry.content) : "";
      }
      const role = entry.message?.role;
      return entry.type === "message" &&
        (role === "user" || role === "assistant")
        ? textOf(entry.message?.content)
        : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

export function formatUndefinedItemReferences(
  problems: readonly UndefinedItemReference[],
): string {
  const details = problems
    .map(
      (problem) =>
        `${problem.path} "${problem.label}" refers to item ${problem.missing.join(", ")}`,
    )
    .join("; ");
  return `Error: ask refused: options refer to numbered items the user has not seen (${details}). The user cannot see your reasoning. First write the items as a numbered list in visible assistant text, one line each with what it is and what you found, then call ask again. Or name each choice in its label and put per-option detail in its preview.`;
}
