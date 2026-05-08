import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import type {
  BashToolDetails,
  BashToolInput,
  EditToolDetails,
  FindToolDetails,
  FindToolInput,
  GrepToolDetails,
  GrepToolInput,
  LsToolDetails,
  LsToolInput,
  ReadToolDetails,
  ReadToolInput,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type {
  ToolDisplayBashOutputConfig,
  ToolDisplayDiffConfig,
  ToolDisplayPreviewConfig,
} from "./config";

interface ThemeLike {
  fg(token: string, text: string): string;
  bold(text: string): string;
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
const SPLIT_DIFF_MIN_WIDTH = 100;

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

function colorDiffLine(line: string, theme: ThemeLike): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return theme.fg("success", line);
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return theme.fg("error", line);
  }
  return theme.fg("dim", line);
}

function terminalWidth(): number {
  return process.stdout.columns && process.stdout.columns > 0
    ? process.stdout.columns
    : 80;
}

function limitedDiffLines(
  diff: string,
  config: ToolDisplayDiffConfig | undefined
): { lines: string[]; omitted: number } {
  const lines = diff.split("\n");
  if (!config?.collapsed || lines.length <= config.previewLines) {
    return { lines, omitted: 0 };
  }
  return {
    lines: lines.slice(0, config.previewLines),
    omitted: lines.length - config.previewLines,
  };
}

function renderUnifiedDiff(
  diff: string,
  theme: ThemeLike,
  config: ToolDisplayDiffConfig | undefined
): string {
  const { lines, omitted } = limitedDiffLines(diff, config);
  let text = lines.map((line) => colorDiffLine(line, theme)).join("\n");
  if (omitted > 0) {
    text += `\n${theme.fg("warning", `… ${omitted} diff lines collapsed`)}`;
  }
  return text;
}

function renderSplitDiff(
  diff: string,
  theme: ThemeLike,
  config: ToolDisplayDiffConfig | undefined,
  width: number
): string {
  const columnWidth = Math.max(20, Math.floor((width - 5) / 2));
  const { lines, omitted } = limitedDiffLines(diff, config);
  const rows = lines.map((line) => {
    if (line.startsWith("-") && !line.startsWith("---")) {
      return `${theme.fg("error", line.slice(0, columnWidth).padEnd(columnWidth))} │ ${"".padEnd(columnWidth)}`;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return `${"".padEnd(columnWidth)} │ ${theme.fg("success", line.slice(0, columnWidth).padEnd(columnWidth))}`;
    }
    const context = theme.fg(
      "dim",
      line.slice(0, columnWidth).padEnd(columnWidth)
    );
    return `${context} │ ${context}`;
  });
  if (omitted > 0) {
    rows.push(theme.fg("warning", `… ${omitted} diff lines collapsed`));
  }
  return rows.join("\n");
}

export function renderFinalDiffResult(
  result: ToolResultLike,
  options: RenderOptionsLike,
  theme: ThemeLike,
  diffConfig?: ToolDisplayDiffConfig
): Text {
  if (options.isPartial) {
    return textLine(theme, "warning", "editing…");
  }
  if (result.isError) {
    return textLine(theme, "error", firstTextLine(result, "edit failed"));
  }

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
    return textLine(theme, "success", summary ?? "applied");
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
    const width = terminalWidth();
    const body =
      width >= SPLIT_DIFF_MIN_WIDTH
        ? renderSplitDiff(diff, theme, diffConfig, width)
        : renderUnifiedDiff(diff, theme, diffConfig);
    text += `\n${body}`;
  }
  return new Text(text, 0, 0);
}

export function renderWriteCall(args: WriteToolInput, theme: ThemeLike): Text {
  return new Text(
    `${theme.fg("toolTitle", theme.bold("write "))}${theme.fg("accent", truncateMiddle(args.path))}${theme.fg("dim", ` (${lineCount(args.content)} lines)`)}`,
    0,
    0
  );
}

function generateSimpleUnifiedDiff(
  path: string,
  oldContent: string,
  newContent: string
): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLength = Math.max(oldLines.length, newLines.length);
  const lines = [`--- ${path}`, `+++ ${path}`];

  for (let index = 0; index < maxLength; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine === newLine) {
      continue;
    }
    if (oldLine !== undefined) {
      lines.push(`-${oldLine}`);
    }
    if (newLine !== undefined) {
      lines.push(`+${newLine}`);
    }
  }

  return lines.join("\n");
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
  const diff = generateSimpleUnifiedDiff(path, oldContent, nextContent);
  return {
    toolDisplay: {
      firstChangedLine: firstChangedLine(oldContent, nextContent),
      writeDiff: diff,
      writeSummary: previous.content === null ? "new file" : "rewrote file",
    },
  };
}
