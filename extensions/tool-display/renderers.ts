import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
  type BashToolDetails,
  type BashToolInput,
  type EditToolDetails,
  type FindToolDetails,
  type FindToolInput,
  type GrepToolDetails,
  type GrepToolInput,
  getLanguageFromPath,
  highlightCode,
  type LsToolDetails,
  type LsToolInput,
  type ReadToolDetails,
  type ReadToolInput,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type {
  ToolDisplayBashOutputConfig,
  ToolDisplayDiffConfig,
  ToolDisplayPreviewConfig,
} from "./config";

interface ThemeLike {
  fg(token: string, text: string): string;
  bold(text: string): string;
  getBgAnsi?(token: string): string;
  getFgAnsi?(token: string): string;
}

interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

interface RtkCompactionDetails {
  rtkCompaction?: {
    savedChars: number;
    originalChars: number;
    finalChars: number;
  };
}

interface RenderOptionsLike {
  expanded?: boolean;
  isPartial?: boolean;
}

export interface ToolDisplayWriteDiffDetails {
  toolDisplay?: {
    writeDiff?: string;
    writeSummary?: string;
    firstChangedLine?: number;
  };
}

const BASH_EXIT_CODE_PATTERN = /exit code: (\d+)/;
const MAX_TITLE_LENGTH = 100;
const WRITE_DIFF_CAPTURE_MAX_BYTES = 512 * 1024;
const FALLBACK_SUMMARY_CHARS = 160;
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const SPLIT_DIFF_MIN_WIDTH = 100;
const INLINE_DIFF_MAX_LINE_LENGTH = 700;
const INLINE_DIFF_MAX_TOKENS = 200;
const INLINE_DIFF_MAX_CELLS = 40_000;
const WRITE_DIFF_MAX_LINES = 4000;
const WRITE_DIFF_MAX_LCS_CELLS = 1_000_000;
const ADD_ROW_BACKGROUND_MIX_RATIO = 0.12;
const REMOVE_ROW_BACKGROUND_MIX_RATIO = 0.12;
const ADD_INLINE_EMPHASIS_MIX_RATIO = 0.26;
const REMOVE_INLINE_EMPHASIS_MIX_RATIO = 0.26;
const ADDITION_TINT_TARGET = { r: 84, g: 190, b: 118 };
const DELETION_TINT_TARGET = { r: 232, g: 95, b: 122 };
const ANSI_BG_RESET = "\x1b[49m";
const ANSI_ESCAPE_PATTERN = "\\x1b";
const ANSI_RGB_COLOR_PATTERN = new RegExp(
  `${ANSI_ESCAPE_PATTERN}\\[(?:3|4)8;2;(\\d{1,3});(\\d{1,3});(\\d{1,3})m`
);
const ANSI_256_COLOR_PATTERN = new RegExp(
  `${ANSI_ESCAPE_PATTERN}\\[(?:3|4)8;5;(\\d{1,3})m`
);

function truncateMiddle(value: string, maxLength = MAX_TITLE_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }

  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}

function textLine(theme: ThemeLike, token: string, value: string): Text {
  return new Text(theme.fg(token, value), 0, 0);
}

function firstText(result: ToolResultLike): string {
  const content = result.content?.[0];
  return content?.type === "text" ? (content.text ?? "") : "";
}

function firstTextLine(result: ToolResultLike, fallback: string): string {
  return firstText(result).split("\n")[0] || fallback;
}

function shouldRenderExpanded(
  options: RenderOptionsLike,
  outputConfig?: ToolDisplayPreviewConfig
): boolean {
  return options.expanded === true || outputConfig?.mode === "expanded";
}

function lineCount(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  return value.split("\n").length;
}

function appendTruncation(
  text: string,
  details: { truncation?: { truncated?: boolean } } | undefined,
  theme: ThemeLike
): string {
  return details?.truncation?.truncated
    ? `${text}${theme.fg("warning", " [truncated]")}`
    : text;
}

function appendRtkCompactionHint(
  text: string,
  details: RtkCompactionDetails | undefined,
  theme: ThemeLike,
  outputConfig?: ToolDisplayPreviewConfig | ToolDisplayBashOutputConfig
): string {
  const rtkHints =
    outputConfig &&
    "rtkHints" in outputConfig &&
    outputConfig.rtkHints === true;
  const compaction = details?.rtkCompaction;
  if (!(rtkHints && compaction)) {
    return text;
  }

  return `${text}${theme.fg(
    "warning",
    ` [compacted by RTK: saved ${compaction.savedChars} chars, original ${compaction.originalChars}, final ${compaction.finalChars}]`
  )}`;
}

function renderExpandedLines(
  text: string,
  lines: string[],
  theme: ThemeLike,
  previewLines = 20
): string {
  let rendered = text;
  for (const line of lines.slice(0, previewLines)) {
    rendered += `\n${theme.fg("dim", line)}`;
  }
  return rendered;
}

export function renderCompactReadCall(
  args: ReadToolInput,
  theme: ThemeLike
): Text {
  const parts: string[] = [];
  if (args.offset !== undefined) {
    parts.push(`offset=${args.offset}`);
  }
  if (args.limit !== undefined) {
    parts.push(`limit=${args.limit}`);
  }

  const suffix = parts.length ? theme.fg("dim", ` (${parts.join(", ")})`) : "";
  return new Text(
    `${theme.fg("toolTitle", theme.bold("read "))}${theme.fg("accent", truncateMiddle(args.path))}${suffix}`,
    0,
    0
  );
}

export function renderCompactReadResult(
  result: ToolResultLike,
  options: RenderOptionsLike,
  theme: ThemeLike,
  outputConfig?: ToolDisplayPreviewConfig
): Text {
  if (options.isPartial) {
    return textLine(theme, "warning", "reading…");
  }
  if (result.isError) {
    return textLine(theme, "error", firstTextLine(result, "read failed"));
  }

  const content = result.content?.[0];
  if (content?.type === "image") {
    return textLine(theme, "success", "image loaded");
  }

  const output = firstText(result);
  const details = result.details as ReadToolDetails | undefined;
  let text = appendTruncation(
    theme.fg("success", `${lineCount(output)} lines`),
    details,
    theme
  );
  text = appendRtkCompactionHint(text, details, theme, outputConfig);
  if (shouldRenderExpanded(options, outputConfig)) {
    text = renderExpandedLines(
      text,
      output.split("\n"),
      theme,
      outputConfig?.previewLines
    );
  }
  return new Text(text, 0, 0);
}

export function renderCompactBashCall(
  args: BashToolInput,
  theme: ThemeLike
): Text {
  const timeout =
    args.timeout === undefined ? "" : theme.fg("dim", ` (${args.timeout}s)`);
  return new Text(
    `${theme.fg("toolTitle", theme.bold("$ "))}${theme.fg("accent", truncateMiddle(args.command))}${timeout}`,
    0,
    0
  );
}

export function renderCompactBashResult(
  result: ToolResultLike,
  options: RenderOptionsLike,
  theme: ThemeLike,
  outputConfig?: ToolDisplayBashOutputConfig
): Text {
  if (options.isPartial) {
    return textLine(theme, "warning", "running…");
  }

  const output = firstText(result);
  const exitMatch = output.match(BASH_EXIT_CODE_PATTERN);
  const exitCode = exitMatch
    ? Number.parseInt(exitMatch[1] ?? "0", 10)
    : undefined;
  const status =
    result.isError || (exitCode !== undefined && exitCode !== 0)
      ? theme.fg(
          "error",
          exitCode === undefined ? "failed" : `exit ${exitCode}`
        )
      : theme.fg("success", "done");
  const details = result.details as BashToolDetails | undefined;
  let text = appendTruncation(
    `${status}${theme.fg("dim", ` (${lineCount(output)} lines)`)}`,
    details,
    theme
  );
  text = appendRtkCompactionHint(text, details, theme, outputConfig);
  if (shouldRenderExpanded(options, outputConfig)) {
    text = renderExpandedLines(
      text,
      output.split("\n"),
      theme,
      outputConfig?.previewLines
    );
  }
  return new Text(text, 0, 0);
}

export function renderCompactGrepCall(
  args: GrepToolInput,
  theme: ThemeLike
): Text {
  const target = args.path ?? ".";
  return new Text(
    `${theme.fg("toolTitle", theme.bold("grep "))}${theme.fg("accent", truncateMiddle(args.pattern))}${theme.fg("dim", ` in ${target}`)}`,
    0,
    0
  );
}

export function renderCompactGrepResult(
  result: ToolResultLike,
  options: RenderOptionsLike,
  theme: ThemeLike,
  outputConfig?: ToolDisplayPreviewConfig
): Text {
  if (options.isPartial) {
    return textLine(theme, "warning", "searching…");
  }
  if (result.isError) {
    return textLine(theme, "error", firstTextLine(result, "grep failed"));
  }
  const output = firstText(result);
  const details = result.details as GrepToolDetails | undefined;
  let text = appendTruncation(
    theme.fg("success", `${lineCount(output)} lines`),
    details,
    theme
  );
  if (details?.matchLimitReached !== undefined) {
    text += theme.fg("warning", ` [limit ${details.matchLimitReached}]`);
  }
  text = appendRtkCompactionHint(text, details, theme, outputConfig);
  if (shouldRenderExpanded(options, outputConfig)) {
    text = renderExpandedLines(
      text,
      output.split("\n"),
      theme,
      outputConfig?.previewLines
    );
  }
  return new Text(text, 0, 0);
}

export function renderCompactFindCall(
  args: FindToolInput,
  theme: ThemeLike
): Text {
  return new Text(
    `${theme.fg("toolTitle", theme.bold("find "))}${theme.fg("accent", truncateMiddle(args.pattern))}${theme.fg("dim", ` in ${args.path ?? "."}`)}`,
    0,
    0
  );
}

export function renderCompactFindResult(
  result: ToolResultLike,
  options: RenderOptionsLike,
  theme: ThemeLike,
  outputConfig?: ToolDisplayPreviewConfig
): Text {
  if (options.isPartial) {
    return textLine(theme, "warning", "finding…");
  }
  if (result.isError) {
    return textLine(theme, "error", firstTextLine(result, "find failed"));
  }
  const output = firstText(result);
  const details = result.details as FindToolDetails | undefined;
  let text = appendTruncation(
    theme.fg("success", `${lineCount(output)} paths`),
    details,
    theme
  );
  if (details?.resultLimitReached !== undefined) {
    text += theme.fg("warning", ` [limit ${details.resultLimitReached}]`);
  }
  if (shouldRenderExpanded(options, outputConfig)) {
    text = renderExpandedLines(
      text,
      output.split("\n"),
      theme,
      outputConfig?.previewLines
    );
  }
  return new Text(text, 0, 0);
}

export function renderCompactLsCall(args: LsToolInput, theme: ThemeLike): Text {
  return new Text(
    `${theme.fg("toolTitle", theme.bold("ls "))}${theme.fg("accent", truncateMiddle(args.path ?? "."))}`,
    0,
    0
  );
}

export function renderCompactLsResult(
  result: ToolResultLike,
  options: RenderOptionsLike,
  theme: ThemeLike,
  outputConfig?: ToolDisplayPreviewConfig
): Text {
  if (options.isPartial) {
    return textLine(theme, "warning", "listing…");
  }
  if (result.isError) {
    return textLine(theme, "error", firstTextLine(result, "ls failed"));
  }
  const output = firstText(result);
  const details = result.details as LsToolDetails | undefined;
  let text = appendTruncation(
    theme.fg("success", `${lineCount(output)} entries`),
    details,
    theme
  );
  if (details?.entryLimitReached !== undefined) {
    text += theme.fg("warning", ` [limit ${details.entryLimitReached}]`);
  }
  if (shouldRenderExpanded(options, outputConfig)) {
    text = renderExpandedLines(
      text,
      output.split("\n"),
      theme,
      outputConfig?.previewLines
    );
  }
  return new Text(text, 0, 0);
}

export function renderEditCall(args: { path: string }, theme: ThemeLike): Text {
  return new Text(
    `${theme.fg("toolTitle", theme.bold("edit "))}${theme.fg("accent", truncateMiddle(args.path))}`,
    0,
    0
  );
}

function diffStats(diff: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      removals += 1;
    }
  }
  return { additions, removals };
}

function terminalWidth(): number {
  return process.stdout.columns && process.stdout.columns > 0
    ? process.stdout.columns
    : 80;
}

interface ParsedDiffLine {
  kind: "add" | "remove" | "context" | "meta";
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

interface ParsedDiffFile {
  oldPath: string;
  newPath: string;
  lines: ParsedDiffLine[];
}

interface RgbColor {
  b: number;
  g: number;
  r: number;
}

interface DiffPalette {
  addEmphasisBgAnsi?: string;
  addRowBgAnsi?: string;
  baseBgAnsi?: string;
  removeEmphasisBgAnsi?: string;
  removeRowBgAnsi?: string;
}

function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let file: ParsedDiffFile | undefined;
  let oldNumber = 1;
  let newNumber = 1;
  let expectingNewPath = false;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (!inHunk && line.startsWith("--- ")) {
      file = {
        oldPath: line.slice(4).trim(),
        newPath: line.slice(4).trim(),
        lines: [],
      };
      files.push(file);
      oldNumber = 1;
      newNumber = 1;
      expectingNewPath = true;
      continue;
    }
    if (expectingNewPath && line.startsWith("+++ ")) {
      if (!file) {
        file = {
          oldPath: line.slice(4).trim(),
          newPath: line.slice(4).trim(),
          lines: [],
        };
        files.push(file);
      }
      file.newPath = line.slice(4).trim();
      expectingNewPath = false;
      continue;
    }
    if (!file) {
      file = { oldPath: "", newPath: "", lines: [] };
      files.push(file);
    }
    const hunk = line.match(HUNK_HEADER_PATTERN);
    if (hunk) {
      oldNumber = Number.parseInt(hunk[1] ?? "1", 10);
      newNumber = Number.parseInt(hunk[2] ?? "1", 10);
      file.lines.push({ kind: "meta", text: line });
      inHunk = true;
      expectingNewPath = false;
    } else if (line.startsWith("-")) {
      file.lines.push({ kind: "remove", oldNumber, text: line.slice(1) });
      oldNumber += 1;
    } else if (line.startsWith("+")) {
      file.lines.push({ kind: "add", newNumber, text: line.slice(1) });
      newNumber += 1;
    } else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      file.lines.push({ kind: "context", newNumber, oldNumber, text });
      oldNumber += 1;
      newNumber += 1;
    }
  }
  return files;
}

function ansi256ToRgb(code: number): RgbColor {
  if (code < 0) {
    return { b: 0, g: 0, r: 0 };
  }
  if (code <= 15) {
    const base16: RgbColor[] = [
      { b: 0, g: 0, r: 0 },
      { b: 0, g: 0, r: 128 },
      { b: 0, g: 128, r: 0 },
      { b: 0, g: 128, r: 128 },
      { b: 128, g: 0, r: 0 },
      { b: 128, g: 0, r: 128 },
      { b: 128, g: 128, r: 0 },
      { b: 192, g: 192, r: 192 },
      { b: 128, g: 128, r: 128 },
      { b: 0, g: 0, r: 255 },
      { b: 0, g: 255, r: 0 },
      { b: 0, g: 255, r: 255 },
      { b: 255, g: 0, r: 0 },
      { b: 255, g: 0, r: 255 },
      { b: 255, g: 255, r: 0 },
      { b: 255, g: 255, r: 255 },
    ];
    return base16[code] ?? { b: 255, g: 255, r: 255 };
  }
  if (code >= 232) {
    const value = Math.max(0, Math.min(255, 8 + (code - 232) * 10));
    return { b: value, g: value, r: value };
  }

  const cube = code - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  const blue = cube % 6;
  const green = Math.floor(cube / 6) % 6;
  const red = Math.floor(cube / 36) % 6;
  return {
    b: levels[blue] ?? 0,
    g: levels[green] ?? 0,
    r: levels[red] ?? 0,
  };
}

function parseAnsiColorCode(ansi: string | undefined): RgbColor | undefined {
  if (!ansi) {
    return undefined;
  }

  const rgbMatch = ANSI_RGB_COLOR_PATTERN.exec(ansi);
  if (rgbMatch) {
    return {
      b: Math.max(0, Math.min(255, Number.parseInt(rgbMatch[3] ?? "0", 10))),
      g: Math.max(0, Math.min(255, Number.parseInt(rgbMatch[2] ?? "0", 10))),
      r: Math.max(0, Math.min(255, Number.parseInt(rgbMatch[1] ?? "0", 10))),
    };
  }

  const bitMatch = ANSI_256_COLOR_PATTERN.exec(ansi);
  if (bitMatch) {
    return ansi256ToRgb(Number.parseInt(bitMatch[1] ?? "0", 10));
  }

  return undefined;
}

function mixRgb(base: RgbColor, tint: RgbColor, ratio: number): RgbColor {
  const clamped = Math.max(0, Math.min(1, ratio));
  return {
    b: base.b * (1 - clamped) + tint.b * clamped,
    g: base.g * (1 - clamped) + tint.g * clamped,
    r: base.r * (1 - clamped) + tint.r * clamped,
  };
}

function rgbToBgAnsi(color: RgbColor): string {
  const b = Math.max(0, Math.min(255, Math.round(color.b)));
  const g = Math.max(0, Math.min(255, Math.round(color.g)));
  const r = Math.max(0, Math.min(255, Math.round(color.r)));
  return `\x1b[48;2;${r};${g};${b}m`;
}

function readThemeAnsi(
  theme: ThemeLike,
  kind: "bg" | "fg",
  token: string
): string | undefined {
  try {
    if (kind === "bg") {
      return theme.getBgAnsi?.(token);
    }
    return theme.getFgAnsi?.(token);
  } catch {
    return undefined;
  }
}

function resolveDiffPalette(theme: ThemeLike): DiffPalette {
  const baseBgAnsi =
    readThemeAnsi(theme, "bg", "toolSuccessBg") ??
    readThemeAnsi(theme, "bg", "toolPendingBg") ??
    readThemeAnsi(theme, "bg", "userMessageBg");
  if (!baseBgAnsi) {
    return {};
  }

  const baseBg = parseAnsiColorCode(baseBgAnsi);
  const addFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffAdded"));
  const removeFg = parseAnsiColorCode(
    readThemeAnsi(theme, "fg", "toolDiffRemoved")
  );

  if (!(baseBg && addFg && removeFg)) {
    return { baseBgAnsi };
  }

  const addTint = mixRgb(addFg, ADDITION_TINT_TARGET, 0.35);
  const removeTint = mixRgb(removeFg, DELETION_TINT_TARGET, 0.65);
  return {
    addEmphasisBgAnsi: rgbToBgAnsi(
      mixRgb(baseBg, addTint, ADD_INLINE_EMPHASIS_MIX_RATIO)
    ),
    addRowBgAnsi: rgbToBgAnsi(
      mixRgb(baseBg, addTint, ADD_ROW_BACKGROUND_MIX_RATIO)
    ),
    baseBgAnsi,
    removeEmphasisBgAnsi: rgbToBgAnsi(
      mixRgb(baseBg, removeTint, REMOVE_INLINE_EMPHASIS_MIX_RATIO)
    ),
    removeRowBgAnsi: rgbToBgAnsi(
      mixRgb(baseBg, removeTint, REMOVE_ROW_BACKGROUND_MIX_RATIO)
    ),
  };
}

function highlightDiffText(path: string, text: string): string {
  const language = getLanguageFromPath(path);
  if (!language) {
    return text;
  }
  try {
    return highlightCode(text, language)[0] ?? text;
  } catch {
    return text;
  }
}

function tokenizeInlineDiff(value: string): string[] {
  return value.match(/\s+|\w+|[^\s\w]+/g) ?? [];
}

function inlineDiffRanges(
  oldText: string,
  newText: string
): { oldChanged: boolean[]; newChanged: boolean[] } | undefined {
  if (
    oldText.length > INLINE_DIFF_MAX_LINE_LENGTH ||
    newText.length > INLINE_DIFF_MAX_LINE_LENGTH
  ) {
    return undefined;
  }

  const oldTokens = tokenizeInlineDiff(oldText);
  const newTokens = tokenizeInlineDiff(newText);
  if (
    oldTokens.length > INLINE_DIFF_MAX_TOKENS ||
    newTokens.length > INLINE_DIFF_MAX_TOKENS ||
    oldTokens.length * newTokens.length > INLINE_DIFF_MAX_CELLS
  ) {
    return undefined;
  }

  const matrix: number[][] = Array.from({ length: oldTokens.length + 1 }, () =>
    Array.from({ length: newTokens.length + 1 }, () => 0)
  );
  for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex -= 1) {
      matrix[oldIndex][newIndex] =
        oldTokens[oldIndex] === newTokens[newIndex]
          ? (matrix[oldIndex + 1]?.[newIndex + 1] ?? 0) + 1
          : Math.max(
              matrix[oldIndex + 1]?.[newIndex] ?? 0,
              matrix[oldIndex]?.[newIndex + 1] ?? 0
            );
    }
  }

  const oldChanged = Array.from({ length: oldTokens.length }, () => true);
  const newChanged = Array.from({ length: newTokens.length }, () => true);
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldTokens.length && newIndex < newTokens.length) {
    if (oldTokens[oldIndex] === newTokens[newIndex]) {
      oldChanged[oldIndex] = false;
      newChanged[newIndex] = false;
      oldIndex += 1;
      newIndex += 1;
    } else if (
      (matrix[oldIndex + 1]?.[newIndex] ?? 0) >=
      (matrix[oldIndex]?.[newIndex + 1] ?? 0)
    ) {
      oldIndex += 1;
    } else {
      newIndex += 1;
    }
  }

  return { oldChanged, newChanged };
}

function renderInlineDiffText(
  text: string,
  changed: boolean[],
  emphasisBgAnsi: string | undefined,
  restoreBgAnsi: string | undefined
): string {
  const restore = restoreBgAnsi ?? ANSI_BG_RESET;
  return tokenizeInlineDiff(text)
    .map((token, index) =>
      changed[index] && emphasisBgAnsi
        ? `${emphasisBgAnsi}${token}${restore}`
        : token
    )
    .join("");
}

function inlineDiffPair(
  oldText: string,
  newText: string,
  palette: DiffPalette
): { oldText: string; newText: string } {
  const ranges = inlineDiffRanges(oldText, newText);
  if (!ranges) {
    return { newText, oldText };
  }
  return {
    newText: renderInlineDiffText(
      newText,
      ranges.newChanged,
      palette.addEmphasisBgAnsi,
      palette.addRowBgAnsi
    ),
    oldText: renderInlineDiffText(
      oldText,
      ranges.oldChanged,
      palette.removeEmphasisBgAnsi,
      palette.removeRowBgAnsi
    ),
  };
}

function createLimitedDiffRows(config: ToolDisplayDiffConfig | undefined): {
  isFull: () => boolean;
  omit: (count?: number) => void;
  result: () => { rows: string[]; omitted: number };
  push: (nextRows: string[]) => void;
} {
  const rows: string[] = [];
  let omitted = 0;
  const limit = config?.collapsed ? config.previewLines : undefined;
  return {
    isFull: () => limit !== undefined && rows.length >= limit,
    omit: (count = 1) => {
      omitted += count;
    },
    result: () => ({ omitted, rows }),
    push: (nextRows) => {
      for (const row of nextRows) {
        if (limit === undefined || rows.length < limit) {
          rows.push(row);
        } else {
          omitted += 1;
        }
      }
    },
  };
}

function diffIndicator(
  kind: ParsedDiffLine["kind"],
  config: ToolDisplayDiffConfig | undefined
): string {
  if (config?.indicatorMode === "none") {
    return "";
  }
  if (config?.indicatorMode === "classic") {
    if (kind === "add") {
      return "+";
    }
    if (kind === "remove") {
      return "-";
    }
    return " ";
  }
  if (kind === "add" || kind === "remove") {
    return "▌";
  }
  return " ";
}

function splitSideIndicator(
  kind: ParsedDiffLine["kind"],
  side: "old" | "new",
  config: ToolDisplayDiffConfig | undefined
): string {
  if (kind === "remove" && side === "old") {
    return diffIndicator(kind, config);
  }
  if (kind === "add" && side === "new") {
    return diffIndicator(kind, config);
  }
  return diffIndicator("context", config);
}

function formatUnifiedRow(
  indicator: string,
  text: string,
  width: number,
  config: ToolDisplayDiffConfig | undefined
): string[] {
  const availableWidth = Math.max(1, width - visibleWidth(indicator));
  if (config?.wordWrap === false) {
    return [`${indicator}${truncateToWidth(text, availableWidth, "")}`];
  }
  return wrapTextWithAnsi(text, availableWidth).map(
    (line, index) =>
      `${index === 0 ? indicator : " ".repeat(visibleWidth(indicator))}${line}`
  );
}

function themedDiffRow(
  token: string,
  text: string,
  rowBgAnsi: string | undefined,
  theme: ThemeLike,
  restoreBgAnsi?: string,
  fillWidth?: number
): string {
  const colored = theme.fg(token, text);
  if (!rowBgAnsi) {
    return colored;
  }

  const filled =
    fillWidth === undefined
      ? colored
      : `${colored}${" ".repeat(Math.max(0, fillWidth - visibleWidth(colored)))}`;
  return `${rowBgAnsi}${filled}${restoreBgAnsi ?? ANSI_BG_RESET}`;
}

function renderUnifiedDiff(
  files: ParsedDiffFile[],
  theme: ThemeLike,
  config: ToolDisplayDiffConfig | undefined,
  width: number,
  palette: DiffPalette
): string {
  const limited = createLimitedDiffRows(config);
  for (const file of files) {
    limited.push([
      theme.fg("dim", truncateToWidth(`--- ${file.oldPath}`, width, "")),
      theme.fg("dim", truncateToWidth(`+++ ${file.newPath}`, width, "")),
    ]);
    for (let index = 0; index < file.lines.length; index += 1) {
      const line = file.lines[index];
      if (!line) {
        continue;
      }
      if (limited.isFull()) {
        limited.omit();
        continue;
      }
      if (line.kind === "add") {
        const previous = file.lines[index - 1];
        const text =
          previous?.kind === "remove"
            ? inlineDiffPair(previous.text, line.text, palette).newText
            : highlightDiffText(file.newPath, line.text);
        limited.push(
          formatUnifiedRow(
            diffIndicator(line.kind, config),
            text,
            width,
            config
          ).map((row) =>
            themedDiffRow(
              "toolDiffAdded",
              row,
              palette.addRowBgAnsi,
              theme,
              palette.baseBgAnsi,
              width
            )
          )
        );
        continue;
      }
      if (line.kind === "remove") {
        const next = file.lines[index + 1];
        const text =
          next?.kind === "add"
            ? inlineDiffPair(line.text, next.text, palette).oldText
            : highlightDiffText(file.oldPath, line.text);
        limited.push(
          formatUnifiedRow(
            diffIndicator(line.kind, config),
            text,
            width,
            config
          ).map((row) =>
            themedDiffRow(
              "toolDiffRemoved",
              row,
              palette.removeRowBgAnsi,
              theme,
              palette.baseBgAnsi,
              width
            )
          )
        );
        continue;
      }
      limited.push(
        formatUnifiedRow(
          diffIndicator(line.kind, config),
          line.text,
          width,
          config
        ).map((row) => theme.fg("toolDiffContext", row))
      );
    }
  }
  const { rows, omitted } = limited.result();
  if (omitted > 0) {
    rows.push(theme.fg("warning", `… ${omitted} diff lines collapsed`));
  }
  return rows.join("\n");
}

function fitCell(value: string, width: number): string {
  return truncateToWidth(value, width, "", true);
}

function wrapCell(
  value: string,
  width: number,
  config: ToolDisplayDiffConfig | undefined
): string[] {
  if (config?.wordWrap === false) {
    return [fitCell(value, width)];
  }
  const wrapped = wrapTextWithAnsi(value, width);
  return (wrapped.length ? wrapped : [""]).map((line) => fitCell(line, width));
}

function renderSplitRow(
  oldNo: string,
  oldText: string,
  oldToken: string,
  oldIndicator: string,
  oldRowBgAnsi: string | undefined,
  newNo: string,
  newText: string,
  newToken: string,
  newIndicator: string,
  newRowBgAnsi: string | undefined,
  numberWidth: number,
  codeWidth: number,
  theme: ThemeLike,
  config: ToolDisplayDiffConfig | undefined,
  restoreBgAnsi: string | undefined
): string[] {
  const oldIndicatorWidth = visibleWidth(oldIndicator);
  const newIndicatorWidth = visibleWidth(newIndicator);
  const oldTextWidth = Math.max(1, codeWidth - oldIndicatorWidth);
  const newTextWidth = Math.max(1, codeWidth - newIndicatorWidth);
  const oldLines = wrapCell(oldText, oldTextWidth, config);
  const newLines = wrapCell(newText, newTextWidth, config);
  const count = Math.max(oldLines.length, newLines.length);
  const rows: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const oldNumber = index === 0 ? oldNo : "";
    const newNumber = index === 0 ? newNo : "";
    const oldMarker =
      index === 0 ? oldIndicator : " ".repeat(oldIndicatorWidth);
    const newMarker =
      index === 0 ? newIndicator : " ".repeat(newIndicatorWidth);
    const oldCell = `${oldNumber.padStart(numberWidth)} │ ${oldMarker}${oldLines[index] ?? fitCell("", oldTextWidth)}`;
    const newCell = `${newNumber.padStart(numberWidth)} │ ${newMarker}${newLines[index] ?? fitCell("", newTextWidth)}`;
    rows.push(
      `${themedDiffRow(oldToken, oldCell, oldRowBgAnsi, theme, restoreBgAnsi)} │ ${themedDiffRow(newToken, newCell, newRowBgAnsi, theme, restoreBgAnsi)}`
    );
  }
  return rows;
}

function renderSplitDiff(
  files: ParsedDiffFile[],
  theme: ThemeLike,
  config: ToolDisplayDiffConfig | undefined,
  width: number,
  palette: DiffPalette
): string {
  const columnWidth = Math.max(20, Math.floor((width - 5) / 2));
  const numberWidth = 4;
  const codeWidth = Math.max(8, columnWidth - numberWidth - 3);
  const limited = createLimitedDiffRows(config);
  for (const file of files) {
    limited.push([
      `${theme.fg("dim", fitCell(file.oldPath || "old", columnWidth))} │ ${theme.fg("dim", fitCell(file.newPath || "new", columnWidth))}`,
    ]);
    for (let index = 0; index < file.lines.length; index += 1) {
      const line = file.lines[index];
      if (!line) {
        continue;
      }
      if (limited.isFull()) {
        limited.omit();
        continue;
      }
      if (line.kind === "meta") {
        const meta = theme.fg("dim", fitCell(line.text, columnWidth));
        limited.push([`${meta} │ ${meta}`]);
        continue;
      }
      const oldNo = line.oldNumber === undefined ? "" : String(line.oldNumber);
      const newNo = line.newNumber === undefined ? "" : String(line.newNumber);
      let oldText = "";
      let newText = "";
      if (line.kind === "remove") {
        const next = file.lines[index + 1];
        oldText =
          next?.kind === "add"
            ? inlineDiffPair(line.text, next.text, palette).oldText
            : highlightDiffText(file.oldPath, line.text);
      } else if (line.kind === "add") {
        const previous = file.lines[index - 1];
        newText =
          previous?.kind === "remove"
            ? inlineDiffPair(previous.text, line.text, palette).newText
            : highlightDiffText(file.newPath, line.text);
      } else {
        oldText = highlightDiffText(file.oldPath, line.text);
        newText = highlightDiffText(file.newPath, line.text);
      }
      limited.push(
        renderSplitRow(
          oldNo,
          oldText,
          line.kind === "remove" ? "toolDiffRemoved" : "toolDiffContext",
          splitSideIndicator(line.kind, "old", config),
          line.kind === "remove" ? palette.removeRowBgAnsi : undefined,
          newNo,
          newText,
          line.kind === "add" ? "toolDiffAdded" : "toolDiffContext",
          splitSideIndicator(line.kind, "new", config),
          line.kind === "add" ? palette.addRowBgAnsi : undefined,
          numberWidth,
          codeWidth,
          theme,
          config,
          palette.baseBgAnsi
        )
      );
    }
  }
  const { rows, omitted } = limited.result();
  if (omitted > 0) {
    rows.push(theme.fg("warning", `… ${omitted} diff lines collapsed`));
  }
  return rows.join("\n");
}

function fitsRendered(text: string, width: number): boolean {
  return new Text(text, 0, 0).render(width).length === text.split("\n").length;
}

function renderAdaptiveDiff(
  diff: string,
  summary: string | undefined,
  statsText: string,
  theme: ThemeLike,
  config: ToolDisplayDiffConfig | undefined,
  width: number
): string {
  const files = parseUnifiedDiff(diff);
  const palette = resolveDiffPalette(theme);
  const summaryText = theme.fg("success", summary ?? statsText);
  const compactText = statsText;
  const choices: Array<() => string> = [];
  const splitMinWidth = config?.splitMinWidth ?? SPLIT_DIFF_MIN_WIDTH;
  const canRenderSplit = width >= splitMinWidth;
  if (config?.viewMode === "unified" || !canRenderSplit) {
    choices.push(() => renderUnifiedDiff(files, theme, config, width, palette));
  } else if (config?.viewMode === "split") {
    choices.push(
      () => renderSplitDiff(files, theme, config, width, palette),
      () => renderUnifiedDiff(files, theme, config, width, palette)
    );
  } else {
    choices.push(
      () => renderSplitDiff(files, theme, config, width, palette),
      () => renderUnifiedDiff(files, theme, config, width, palette)
    );
  }
  choices.push(
    () => compactText,
    () => summaryText
  );
  for (const renderChoice of choices) {
    const choice = renderChoice();
    if (fitsRendered(choice, width)) {
      return choice;
    }
  }
  return summaryText;
}

function renderFinalDiffText(
  result: ToolResultLike,
  options: RenderOptionsLike,
  theme: ThemeLike,
  diffConfig: ToolDisplayDiffConfig | undefined,
  width: number
): string {
  const diff =
    (
      result.details as
        | EditToolDetails
        | ToolDisplayWriteDiffDetails
        | undefined
    )?.diff ??
    (result.details as ToolDisplayWriteDiffDetails | undefined)?.toolDisplay
      ?.writeDiff;
  const summary = (result.details as ToolDisplayWriteDiffDetails | undefined)
    ?.toolDisplay?.writeSummary;
  if (!diff || diffConfig?.enabled === false) {
    return theme.fg("success", summary ?? "applied");
  }

  const stats = diffStats(diff);
  const changedLine = (
    result.details as ToolDisplayWriteDiffDetails | undefined
  )?.toolDisplay?.firstChangedLine;
  let text = `${theme.fg("success", `+${stats.additions}`)}${theme.fg("dim", " / ")}${theme.fg("error", `-${stats.removals}`)}`;
  if (summary) {
    text += theme.fg("dim", ` (${summary})`);
  }
  if (changedLine !== undefined) {
    text += theme.fg("dim", ` line ${changedLine}`);
  }
  if (options.expanded || diffConfig?.collapsed === false) {
    const body = renderAdaptiveDiff(
      diff,
      summary,
      text,
      theme,
      diffConfig,
      width
    );
    text += `\n${body}`;
  }
  return text;
}

class ResponsiveDiffText implements Component {
  private readonly diffConfig: ToolDisplayDiffConfig | undefined;
  private readonly options: RenderOptionsLike;
  private readonly result: ToolResultLike;
  private readonly theme: ThemeLike;
  text: string;

  constructor(
    result: ToolResultLike,
    options: RenderOptionsLike,
    theme: ThemeLike,
    diffConfig: ToolDisplayDiffConfig | undefined
  ) {
    this.diffConfig = diffConfig;
    this.options = options;
    this.result = result;
    this.theme = theme;
    this.text = renderFinalDiffText(
      result,
      options,
      theme,
      diffConfig,
      terminalWidth()
    );
  }

  invalidate(): void {
    this.text = renderFinalDiffText(
      this.result,
      this.options,
      this.theme,
      this.diffConfig,
      terminalWidth()
    );
  }

  render(width: number): string[] {
    this.text = renderFinalDiffText(
      this.result,
      this.options,
      this.theme,
      this.diffConfig,
      width
    );
    return new Text(this.text, 0, 0).render(width);
  }
}

export function renderFinalDiffResult(
  result: ToolResultLike,
  options: RenderOptionsLike,
  theme: ThemeLike,
  diffConfig?: ToolDisplayDiffConfig
): Component {
  if (options.isPartial) {
    return textLine(theme, "warning", "editing…");
  }
  if (result.isError) {
    return textLine(theme, "error", firstTextLine(result, "edit failed"));
  }

  return new ResponsiveDiffText(result, options, theme, diffConfig);
}

export function renderWriteCall(args: WriteToolInput, theme: ThemeLike): Text {
  return new Text(
    `${theme.fg("toolTitle", theme.bold("write "))}${theme.fg("accent", truncateMiddle(args.path))}${theme.fg("dim", ` (${lineCount(args.content)} lines)`)}`,
    0,
    0
  );
}

function generateLcsUnifiedDiff(
  path: string,
  oldContent: string,
  newContent: string
): { diff?: string; summary?: string } {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const cells = oldLines.length * newLines.length;
  if (
    oldLines.length > WRITE_DIFF_MAX_LINES ||
    newLines.length > WRITE_DIFF_MAX_LINES ||
    cells > WRITE_DIFF_MAX_LCS_CELLS
  ) {
    return {
      summary: `rewrote file; detailed diff omitted (${oldLines.length} old lines, ${newLines.length} new lines)`,
    };
  }

  const matrix: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
    Array.from({ length: newLines.length + 1 }, () => 0)
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      matrix[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? (matrix[oldIndex + 1]?.[newIndex + 1] ?? 0) + 1
          : Math.max(
              matrix[oldIndex + 1]?.[newIndex] ?? 0,
              matrix[oldIndex]?.[newIndex + 1] ?? 0
            );
    }
  }

  const lines = [`--- ${path}`, `+++ ${path}`];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      lines.push(` ${oldLines[oldIndex]}`);
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex < newLines.length &&
      (oldIndex >= oldLines.length ||
        (matrix[oldIndex]?.[newIndex + 1] ?? 0) >
          (matrix[oldIndex + 1]?.[newIndex] ?? 0))
    ) {
      lines.push(`+${newLines[newIndex]}`);
      newIndex += 1;
    } else if (oldIndex < oldLines.length) {
      lines.push(`-${oldLines[oldIndex]}`);
      oldIndex += 1;
    }
  }

  return { diff: lines.join("\n") };
}

function firstChangedLine(
  oldContent: string,
  newContent: string
): number | undefined {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLength = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (oldLines[index] !== newLines[index]) {
      return index + 1;
    }
  }
  return undefined;
}

export function capturePreviousWriteContent(
  cwd: string,
  path: string
): { ok: true; content: string | null } | { ok: false; summary: string } {
  const workspace = resolve(cwd);
  const absolutePath = resolve(workspace, path);
  const relativePath = relative(workspace, absolutePath);

  if (
    relativePath.startsWith("..") ||
    relativePath === "" ||
    relativePath.startsWith("/")
  ) {
    return {
      ok: false,
      summary: "previous content unavailable: outside workspace",
    };
  }

  try {
    if (!existsSync(absolutePath)) {
      return { ok: true, content: null };
    }
    const bytes = statSync(absolutePath).size;
    if (bytes > WRITE_DIFF_CAPTURE_MAX_BYTES) {
      const preview = readFileSync(absolutePath)
        .subarray(0, FALLBACK_SUMMARY_CHARS)
        .toString("utf8")
        .replaceAll("\n", "\\n");
      return {
        ok: false,
        summary: `previous content too large (${bytes} bytes; starts ${JSON.stringify(preview)})`,
      };
    }
    return { ok: true, content: readFileSync(absolutePath, "utf8") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, summary: `previous content unavailable: ${message}` };
  }
}

export function createWriteDiffDetails(
  path: string,
  nextContent: string,
  previous: ReturnType<typeof capturePreviousWriteContent>
): ToolDisplayWriteDiffDetails {
  if (!previous.ok) {
    return { toolDisplay: { writeSummary: previous.summary } };
  }

  const oldContent = previous.content ?? "";
  const generated = generateLcsUnifiedDiff(path, oldContent, nextContent);
  return {
    toolDisplay: {
      firstChangedLine: firstChangedLine(oldContent, nextContent),
      writeDiff: generated.diff,
      writeSummary:
        generated.summary ??
        (previous.content === null ? "new file" : "rewrote file"),
    },
  };
}
