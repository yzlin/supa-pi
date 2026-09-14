import { stripVTControlCharacters } from "node:util";

import type { Component } from "@earendil-works/pi-tui";
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type { LspOperation } from "./types";

export interface LspToolArgs {
  operation?: string;
  filePath?: string;
  line?: number;
  character?: number;
  query?: string;
}

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  information: number;
  hints: number;
  other: number;
  total: number;
}

export type LspPresentationOutcome =
  | {
      kind: "diagnostics";
      status: "success" | "incomplete" | "unavailable";
      counts: DiagnosticCounts;
      failures?: string[];
    }
  | {
      kind: "information";
      found: boolean;
    }
  | {
      kind: "count";
      noun: string;
      count: number;
      emptyLabel?: string;
    }
  | {
      kind: "error";
      message?: string;
    };

export interface LspPresentationDetails {
  operation: LspOperation;
  result: LspPresentationOutcome;
  durationMs?: number;
}

export interface LspPresentationState {
  lspPresentation?: {
    startedAt?: number;
    timer?: ReturnType<typeof setTimeout>;
    settled?: boolean;
    error?: boolean;
    metadata?: LspPresentationDetails;
  };
}

export interface LspTheme {
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
  bold(text: string): string;
}

interface LspToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

interface RenderContextLike {
  args: LspToolArgs;
  state: LspPresentationState;
  invalidate(): void;
  toolCallId?: string;
  isError?: boolean;
}

const LSP_PRESENTATION_KEY = "lspPresentation";
const LSP_ICON = "🔎";
const AT_PREFIX_REGEX = /^@/u;
const POSITION_OPERATIONS = new Set([
  "hover",
  "goToDefinition",
  "findReferences",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "codeActions",
]);

const presentationByCallId = new Map<string, LspPresentationDetails>();
const timers = new Map<ReturnType<typeof setTimeout>, LspPresentationState>();

export function attachLspPresentation(
  details: unknown,
  metadata: LspPresentationDetails
): Record<string, unknown> {
  const base =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : {};
  return { ...base, [LSP_PRESENTATION_KEY]: metadata };
}

export function getLspPresentation(
  details: unknown
): LspPresentationDetails | undefined {
  if (!details || typeof details !== "object") {
    return;
  }
  const metadata = (details as Record<string, unknown>)[LSP_PRESENTATION_KEY];
  if (!metadata || typeof metadata !== "object") {
    return;
  }
  const value = metadata as Partial<LspPresentationDetails>;
  if (typeof value.operation !== "string" || !value.result) {
    return;
  }
  return metadata as LspPresentationDetails;
}

export function rememberLspPresentation(
  toolCallId: string,
  metadata: LspPresentationDetails
): void {
  presentationByCallId.set(toolCallId, metadata);
  if (presentationByCallId.size > 256) {
    const oldest = presentationByCallId.keys().next().value;
    if (oldest !== undefined) {
      presentationByCallId.delete(oldest);
    }
  }
}

export function getLspPresentationForCall(
  toolCallId: string | undefined
): LspPresentationDetails | undefined {
  return toolCallId ? presentationByCallId.get(toolCallId) : undefined;
}

export function cleanupLspPresentation(): void {
  presentationByCallId.clear();
}

export function cleanupLspPresentationTimers(): void {
  for (const [timer, state] of timers) {
    clearTimeout(timer);
    if (state.lspPresentation?.timer === timer) {
      state.lspPresentation.timer = undefined;
    }
    timers.delete(timer);
  }
}

function stateFor(
  state: LspPresentationState
): NonNullable<LspPresentationState["lspPresentation"]> {
  state.lspPresentation ??= {};
  return state.lspPresentation;
}

function stopTimer(state: LspPresentationState): void {
  const presentation = stateFor(state);
  if (!presentation.timer) {
    return;
  }
  clearTimeout(presentation.timer);
  timers.delete(presentation.timer);
  presentation.timer = undefined;
}

function startTimer(state: LspPresentationState, invalidate: () => void): void {
  const presentation = stateFor(state);
  presentation.startedAt ??= Date.now();
  if (presentation.timer || presentation.settled) {
    return;
  }
  const elapsed = Date.now() - presentation.startedAt;
  const delay = Math.max(1, 1000 - (elapsed % 1000));
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (presentation.timer === timer) {
      presentation.timer = undefined;
    }
    if (presentation.settled) {
      return;
    }
    invalidate();
    startTimer(state, invalidate);
  }, delay);
  timer.unref?.();
  presentation.timer = timer;
  timers.set(timer, state);
}

function singleLine(value: unknown): string {
  return [
    ...stripVTControlCharacters(String(value ?? "")).replace(/\s+/gu, " "),
  ]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
    })
    .join("")
    .trim();
}

function targetFor(args: LspToolArgs): string {
  if (args.operation === "workspaceSymbol") {
    return singleLine(args.query) || "query";
  }

  const filePath =
    singleLine(args.filePath?.replace(AT_PREFIX_REGEX, "")) || "file";
  if (POSITION_OPERATIONS.has(args.operation ?? "")) {
    return `${filePath}:${args.line ?? "?"}:${args.character ?? "?"}`;
  }
  return filePath;
}

export function formatToolDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 1) {
    return "<1s";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m ${String(remainder).padStart(2, "0")}s`;
}

function fitTail(
  text: string,
  width: number,
  measuredWidth = visibleWidth(text)
): string {
  if (measuredWidth <= width) {
    return text;
  }
  if (width <= 1) {
    return truncateToWidth(text, width, "");
  }
  const tailWidth = Math.max(1, Math.floor((width - 1) / 2));
  const tail = sliceByColumn(text, measuredWidth - tailWidth, tailWidth, true);
  return `${truncateToWidth(text, width - visibleWidth(tail) - 1, "")}…${tail}`;
}

function fitMiddle(
  prefix: string,
  middle: string,
  suffix: string,
  width: number
): string {
  const full = `${prefix}${middle}${suffix}`;
  if (visibleWidth(full) <= width) {
    return full;
  }
  const available = width - visibleWidth(prefix) - visibleWidth(suffix);
  if (available <= 1) {
    return fitTail(full, width);
  }
  const middleWidth = visibleWidth(middle);
  const tail = sliceByColumn(
    middle,
    Math.max(0, middleWidth - available + 1),
    available - 1,
    true
  );
  return `${prefix}…${tail}${suffix}`;
}

function backgroundLine(
  text: string,
  width: number,
  theme: LspTheme,
  error: boolean,
  settled: boolean
): string {
  let token = "toolPendingBg";
  if (error) {
    token = "toolErrorBg";
  } else if (settled) {
    token = "toolSuccessBg";
  }
  const textWidth = visibleWidth(text);
  const fitted = fitTail(text, Math.max(0, width), textWidth);
  const fittedWidth = textWidth <= width ? textWidth : visibleWidth(fitted);
  return theme.bg(token, fitted + " ".repeat(Math.max(0, width - fittedWidth)));
}

function diagnosticSummary(counts: DiagnosticCounts): string {
  const parts: string[] = [];
  const labels: [number, string][] = [
    [counts.errors, "error"],
    [counts.warnings, "warning"],
    [counts.information, "info"],
    [counts.hints, "hint"],
    [counts.other, "other"],
  ];
  for (const [count, label] of labels) {
    if (count > 0) {
      parts.push(`${count} ${label}${count === 1 ? "" : "s"}`);
    }
  }
  return parts.join(" · ") || "no diagnostics";
}

function outcomeSummary(
  metadata: LspPresentationDetails | undefined,
  isError: boolean
): string {
  if (!metadata) {
    return isError ? "error" : "result available";
  }

  const outcome = metadata.result;
  if (outcome.kind === "diagnostics") {
    if (outcome.status === "unavailable") {
      return outcome.failures && outcome.failures.length > 0
        ? "diagnostics unavailable · error"
        : "diagnostics unavailable";
    }
    const summary = diagnosticSummary(outcome.counts);
    return outcome.status === "incomplete"
      ? `${summary} · incomplete`
      : summary;
  }
  if (isError || outcome.kind === "error") {
    return "error";
  }
  if (outcome.kind === "information") {
    return outcome.found ? "found" : "no information";
  }
  const noun =
    outcome.count === 1 || outcome.noun.endsWith("s")
      ? outcome.noun
      : `${outcome.noun}s`;
  return outcome.count > 0
    ? `${outcome.count} ${noun} found`
    : `no ${outcome.emptyLabel ?? noun}`;
}

function textOutput(result: LspToolResultLike): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

class ExistingResultText implements Component {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  invalidate(): void {
    return;
  }

  render(width: number): string[] {
    if (width <= 0) {
      return [];
    }
    return this.text
      .split(/\r\n|\n|\r/gu)
      .flatMap((line) => wrapTextWithAnsi(line, width));
  }
}

class HeaderComponent implements Component {
  private readonly args: LspToolArgs;
  private readonly state: LspPresentationState;
  private readonly theme: LspTheme;

  constructor(
    args: LspToolArgs,
    theme: LspTheme,
    state: LspPresentationState,
    invalidate: () => void
  ) {
    this.args = args;
    this.theme = theme;
    this.state = state;
    startTimer(state, invalidate);
  }

  invalidate(): void {
    return;
  }

  render(width: number): string[] {
    const presentation = stateFor(this.state);
    let status = "•";
    let statusToken = "warning";
    if (presentation.settled) {
      status = presentation.error ? "×" : "✓";
      statusToken = presentation.error ? "error" : "success";
    }
    const operation = singleLine(this.args.operation) || "operation";
    const target = targetFor(this.args);
    const first = `${this.theme.fg("dim", "┊")} ${this.theme.fg(statusToken, status)} ${this.theme.fg("accent", LSP_ICON)} ${this.theme.fg("accent", this.theme.bold("LSP"))} ${operation}`;
    const lines = [first];
    if (!presentation.settled) {
      const elapsed = Date.now() - (presentation.startedAt ?? Date.now());
      lines.push(
        fitMiddle(
          this.theme.fg("dim", "┊   "),
          target,
          ` ${this.theme.fg("dim", `→ ${formatToolDuration(elapsed)}`)}`,
          width
        )
      );
    }
    return lines.map((line) =>
      backgroundLine(
        line,
        width,
        this.theme,
        presentation.error === true,
        presentation.settled === true
      )
    );
  }
}

class ResultComponent implements Component {
  private readonly summary: string | ((width: number) => string);
  private readonly body: Component | undefined;
  private readonly theme: LspTheme;
  private readonly error: boolean;
  private readonly settled: boolean;
  private readonly showSummary: boolean;

  constructor(
    summary: string | ((width: number) => string),
    theme: LspTheme,
    error: boolean,
    settled: boolean,
    body: Component | undefined,
    showSummary: boolean
  ) {
    this.summary = summary;
    this.theme = theme;
    this.error = error;
    this.settled = settled;
    this.body = body;
    this.showSummary = showSummary;
  }

  invalidate(): void {
    this.body?.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    if (this.showSummary) {
      const summary =
        typeof this.summary === "function" ? this.summary(width) : this.summary;
      lines.push(
        backgroundLine(summary, width, this.theme, this.error, this.settled)
      );
    }
    for (const line of this.body?.render(width) ?? []) {
      lines.push(
        backgroundLine(line, width, this.theme, this.error, this.settled)
      );
    }
    return lines;
  }
}

export function renderLspToolCall(
  args: LspToolArgs,
  theme: LspTheme,
  context: Pick<RenderContextLike, "state" | "invalidate">
): Component {
  return new HeaderComponent(args, theme, context.state, context.invalidate);
}

export function renderLspToolResult(
  result: LspToolResultLike,
  options: { expanded: boolean; isPartial: boolean },
  theme: LspTheme,
  context: Pick<RenderContextLike, "args" | "state" | "toolCallId" | "isError">
): Component {
  const state = stateFor(context.state);
  const error = result.isError === true || context.isError === true;
  const metadata =
    getLspPresentation(result.details) ??
    getLspPresentationForCall(context.toolCallId) ??
    state.metadata;
  if (metadata) {
    state.metadata = metadata;
  }

  if (!options.isPartial) {
    state.settled = true;
    state.error = error;
    stopTimer(context.state);
  }

  const durationMs =
    metadata?.durationMs ??
    (state.startedAt === undefined ? 0 : Date.now() - state.startedAt);
  const target = targetFor(context.args);
  const summary = `${outcomeSummary(metadata, error)} · ${formatToolDuration(durationMs)}`;
  const body =
    !options.isPartial && options.expanded && textOutput(result)
      ? new ExistingResultText(textOutput(result))
      : undefined;

  return new ResultComponent(
    (width) =>
      fitMiddle(
        theme.fg("dim", "┊   "),
        target,
        ` ${theme.fg("dim", "→")} ${theme.fg(error ? "error" : "dim", summary)}`,
        width
      ),
    theme,
    error,
    !options.isPartial,
    body,
    !options.isPartial
  );
}
