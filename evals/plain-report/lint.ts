// Offline calibration linter for the plain-report skill. Warnings only; it never blocks.
// Rules paraphrase skills/plain-report/SKILL.md. No STE specification text or dictionary is copied.

export type Rule =
  | "sentence-length"
  | "paragraph-length"
  | "passive-voice"
  | "avoid-word"
  | "telegraph";

export interface Warning {
  line: number;
  rule: Rule;
  message: string;
  suggestion?: string;
}

export interface LintResult {
  warnings: Warning[];
  sentences: number;
  flaggedSentences: number;
  /** Share of prose sentences with no sentence-level warning, 0..1. */
  compliance: number;
  /** "a", "an", and "the" per 100 prose words; low values mean telegraph style. */
  articleRate: number;
}

export const TARGET_COMPLIANCE = 0.8;
const MAX_WORDS = { procedural: 20, descriptive: 25 } as const;
const MAX_SENTENCES = 6;
// Calibrated on 2026-10 Final reports: complete-sentence prose had ~9-10, telegraph ~1-3.
const MIN_ARTICLE_RATE = 4;
const MIN_WORDS_FOR_ARTICLE_RATE = 50;

const AVOID_WORDS: Record<string, string> = {
  utilize: "use",
  utilise: "use",
  leverage: "use",
  commence: "start",
  terminate: "stop",
  "prior to": "before",
  "in order to": "to",
  subsequently: "then",
  facilitate: "help",
  approximately: "about",
  numerous: "many",
  ascertain: "find out",
};
const AVOID_RE = Object.entries(AVOID_WORDS)
  .toSorted((a, b) => b[0].length - a[0].length)
  .map(([word, suggestion]) => ({
    re: new RegExp(`\\b${word.replace(/ /g, "\\s+")}\\b`, "i"),
    word,
    suggestion,
  }));

// `un-` participles ("is unchanged") describe a state, not an action.
const PASSIVE =
  /\b(?:am|is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?((?!un)\w+ed|known|done|made|given|taken|seen|written|built|shown|sent|kept|held|found|run|chosen|broken)\b/i;
const WORD = /[A-Za-z0-9][\w'’-]*/g;
const ARTICLE = /^(?:a|an|the)$/i;
const ABBREVIATION = /\b(e\.g|i\.e|etc|vs|cf)\./gi;
// Private-use placeholder keeps abbreviation dots out of sentence splitting.
const DOT = "\uE000";

export function lintPlainReport(markdown: string): LintResult {
  const warnings: Warning[] = [];
  let sentences = 0;
  let flaggedSentences = 0;
  let words = 0;
  let articles = 0;
  let paragraph: { line: number; text: string[] } | null = null;
  let inFence = false;

  const checkProse = (
    text: string,
    line: number,
    kind: keyof typeof MAX_WORDS,
  ) => {
    const units = splitSentences(clean(text));
    for (const sentence of units) {
      const tokens = sentence.match(WORD) ?? [];
      words += tokens.length;
      articles += tokens.filter((token) => ARTICLE.test(token)).length;
      const before = warnings.length;
      checkSentence(sentence, line, kind, warnings);
      sentences += 1;
      if (warnings.length > before) {
        flaggedSentences += 1;
      }
    }
    return units.length;
  };

  const flush = () => {
    if (!paragraph) {
      return;
    }
    const count = checkProse(
      paragraph.text.join(" "),
      paragraph.line,
      "descriptive",
    );
    if (count > MAX_SENTENCES) {
      warnings.push({
        line: paragraph.line,
        rule: "paragraph-length",
        message: `${count} sentences (max ${MAX_SENTENCES})`,
        suggestion: "split the paragraph or use a list",
      });
    }
    paragraph = null;
  };

  for (const [index, raw] of markdown.split("\n").entries()) {
    const line = index + 1;
    const trimmed = raw.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const item = trimmed.match(/^(?:(\d+)[.)]|[-*+])\s+(.*)$/);
    if (
      !trimmed ||
      /^#{1,6}\s/.test(trimmed) ||
      /^[-*_]{3,}$/.test(trimmed) ||
      trimmed.startsWith("|") ||
      trimmed.startsWith(">") ||
      (!item && /^( {4,}|\t)/.test(raw))
    ) {
      flush();
      continue;
    }
    if (item) {
      flush();
      checkProse(item[2], line, item[1] ? "procedural" : "descriptive");
      continue;
    }
    paragraph ??= { line, text: [] };
    paragraph.text.push(trimmed);
  }
  flush();

  const articleRate = words === 0 ? 0 : (articles * 100) / words;
  if (words >= MIN_WORDS_FOR_ARTICLE_RATE && articleRate < MIN_ARTICLE_RATE) {
    warnings.push({
      line: 1,
      rule: "telegraph",
      message: `${articleRate.toFixed(1)} articles per 100 words (min ${MIN_ARTICLE_RATE})`,
      suggestion: "write complete sentences with articles",
    });
  }

  return {
    warnings,
    sentences,
    flaggedSentences,
    compliance: sentences === 0 ? 1 : 1 - flaggedSentences / sentences,
    articleRate,
  };
}

export function formatWarning(warning: Warning): string {
  const fix = warning.suggestion ? ` → ${warning.suggestion}` : "";
  return `L${warning.line} [${warning.rule}] ${warning.message}${fix}`;
}

/** Removes Exact Text (code, paths, links, quotes) so rules see only surrounding prose. */
function clean(text: string): string {
  return text
    .replace(/`[^`]*`/g, " ")
    .replace(/~~[^~]*~~/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/"[^"]*"|“[^”]*”/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\S*[/\\]\S*/g, " ")
    .replace(/\b[\w-]+\.(?:ts|tsx|js|mjs|json|md|sh|yml|yaml)\b/g, " ")
    .replace(/[*_]{1,3}/g, "");
}

export function splitSentences(text: string): string[] {
  return text
    .replace(ABBREVIATION, (match) => match.replaceAll(".", DOT))
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replaceAll(DOT, ".").trim())
    .filter((sentence) => /[A-Za-z]/.test(sentence));
}

function checkSentence(
  sentence: string,
  line: number,
  kind: keyof typeof MAX_WORDS,
  out: Warning[],
): void {
  const words = sentence.match(WORD)?.length ?? 0;
  if (words > MAX_WORDS[kind]) {
    out.push({
      line,
      rule: "sentence-length",
      message: `${words} words (max ${MAX_WORDS[kind]} for ${kind} text)`,
      suggestion: "split into one topic per sentence",
    });
  }
  const passive = sentence.match(PASSIVE);
  if (passive) {
    out.push({
      line,
      rule: "passive-voice",
      message: `"${passive[0]}"`,
      suggestion: "name the actor and use active voice",
    });
  }
  for (const { re, word, suggestion } of AVOID_RE) {
    if (re.test(sentence)) {
      out.push({ line, rule: "avoid-word", message: `"${word}"`, suggestion });
    }
  }
}
