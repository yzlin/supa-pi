/*
 * Apache-2.0 source notice: ported from mitsuhiko/agent-stuff
 * extensions/unified-edit.ts at commit
 * 4bce45560fa55ace2f5dc8634a63a2af464ddc8b.
 * Copyright Armin Ronacher and contributors. Licensed under Apache-2.0.
 * Modified for supa-pi: isolated matcher API and ambiguity rejection.
 */

export interface TextEdit {
  oldText: string;
  newText: string;
  removeLineTerminator?: boolean;
}

export interface MatcherBudget {
  remaining: number;
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function isWholeLine(
  content: string,
  start: number,
  length: number,
  needle: string
): boolean {
  const end = start + length;
  return (
    (start === 0 || content[start - 1] === "\n") &&
    (needle.endsWith("\n") || end === content.length || content[end] === "\n")
  );
}

function locations(
  content: string,
  needle: string,
  wholeLines: boolean,
  budget?: MatcherBudget
): number[] {
  if (!needle) {
    return [];
  }
  if (budget) {
    budget.remaining -= Math.max(1, content.length - needle.length + 1);
    if (budget.remaining < 0) {
      throw new Error("Matcher comparison limit exceeded.");
    }
  }
  const result: number[] = [];
  let at = content.indexOf(needle);
  while (at !== -1) {
    if (!wholeLines || isWholeLine(content, at, needle.length, needle)) {
      result.push(at);
    }
    at = content.indexOf(needle, at + 1);
  }
  return result;
}

interface Match {
  index: number;
  length: number;
  fuzzy: boolean;
}

function uniqueMatch(
  content: string,
  needle: string,
  wholeLines: boolean,
  path: string,
  budget?: MatcherBudget
): Match {
  const exact = locations(content, needle, wholeLines, budget);
  if (exact.length > 1) {
    throw new Error(
      `Found ${exact.length} occurrences of the text in ${path}. The text must be unique.`
    );
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyNeedle = normalizeForFuzzyMatch(needle);
  const fuzzy = locations(fuzzyContent, fuzzyNeedle, wholeLines, budget);
  if (exact.length === 1) {
    if (fuzzy.length > 1) {
      throw new Error(
        `Found ${fuzzy.length} fuzzy occurrences of the text in ${path}. The text must be unique.`
      );
    }
    return { index: exact[0], length: needle.length, fuzzy: false };
  }
  if (fuzzy.length > 1) {
    throw new Error(
      `Found ${fuzzy.length} fuzzy occurrences of the text in ${path}. The text must be unique.`
    );
  }
  if (fuzzy.length === 0) {
    throw new Error(`Could not find the exact text in ${path}.`);
  }
  return { index: fuzzy[0], length: fuzzyNeedle.length, fuzzy: true };
}

function lineSpans(content: string): Array<{ start: number; end: number }> {
  const lines = content.match(/[^\n]*\n|[^\n]+/g) ?? [];
  let offset = 0;
  return lines.map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

/** Apply all edits against the same original content, rejecting ambiguity/overlap. */
export function applyOriginalContentEdits(
  content: string,
  edits: TextEdit[],
  path: string,
  wholeLines = true,
  budget?: MatcherBudget
): string {
  const normalized = normalizeToLF(content);
  const prepared = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
    removeLineTerminator: edit.removeLineTerminator === true,
  }));
  if (prepared.some((edit) => edit.oldText.length === 0)) {
    throw new Error(`oldText must not be empty in ${path}.`);
  }
  const initial = prepared.map((edit) =>
    uniqueMatch(normalized, edit.oldText, wholeLines, path, budget)
  );
  const fuzzy = initial.some((match) => match.fuzzy);
  const base = fuzzy ? normalizeForFuzzyMatch(normalized) : normalized;
  const matches = prepared.map((edit, index) => {
    const match = uniqueMatch(base, edit.oldText, wholeLines, path, budget);
    return {
      ...match,
      length:
        edit.removeLineTerminator && base[match.index + match.length] === "\n"
          ? match.length + 1
          : match.length,
      newText: edit.newText,
      editIndex: index,
    };
  });
  matches.sort((a, b) => a.index - b.index);
  for (let i = 1; i < matches.length; i++) {
    if (matches[i - 1].index + matches[i - 1].length > matches[i].index) {
      throw new Error(
        `edits[${matches[i - 1].editIndex}] and edits[${matches[i].editIndex}] overlap in ${path}.`
      );
    }
  }

  if (!fuzzy) {
    let result = base;
    for (const match of matches.toReversed()) {
      result =
        result.slice(0, match.index) +
        match.newText +
        result.slice(match.index + match.length);
    }
    if (result === normalized) {
      throw new Error(`No changes made to ${path}.`);
    }
    return result;
  }

  // Fuzzy normalization changes line widths. Replace complete affected lines in
  // the normalized base while copying all untouched original lines verbatim.
  const spans = lineSpans(base);
  let result = normalized;
  for (const match of matches.toReversed()) {
    const startLine = spans.findIndex(
      (span) => match.index >= span.start && match.index < span.end
    );
    let endLine = startLine;
    while (spans[endLine].end < match.index + match.length) {
      endLine++;
    }
    const start = lineSpans(result)[startLine].start;
    const end = lineSpans(result)[endLine].end;
    const baseSlice = base.slice(spans[startLine].start, spans[endLine].end);
    const local = match.index - spans[startLine].start;
    const replacement =
      baseSlice.slice(0, local) +
      match.newText +
      baseSlice.slice(local + match.length);
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  if (result === normalized) {
    throw new Error(`No changes made to ${path}.`);
  }
  return result;
}
