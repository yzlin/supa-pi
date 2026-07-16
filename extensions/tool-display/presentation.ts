import { stripVTControlCharacters } from "node:util";

import { type Static, Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTwoFilesPatch } from "diff";

import type {
  TObject,
  TProperties,
  TString,
} from "../../node_modules/@earendil-works/pi-ai/node_modules/typebox";
import type { ToolRenderContext } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types";
import { MAX_DIFF_BYTES, MAX_DIFF_LINES } from "./edit-tool";
import { collectPatchCallPreviewFiles } from "./renderers";
import {
  isPatchLikePayload,
  parsePatch,
  parseRowScript,
} from "./unified-edit-parser";
import { buildUnifiedEditPlan } from "./unified-edit-planner";

export type OwnedToolName = "read" | "write" | "edit" | "grep" | "find" | "ls";

interface ArgsLike {
  command?: string;
  reasoning?: string;
  path?: string;
  pattern?: string;
  content?: string;
  text?: string;
  multi?: Array<{ path?: string }>;
  edits?: Array<{ path?: string }> | string;
  patch?: string;
}

type ReasonedSchema<P extends TProperties> = TObject<
  { reasoning: TString } & P
>;

interface ToolResultLike<D = unknown> {
  content: Array<{ type: string; text?: string }>;
  details?: D;
  isError?: boolean;
}

interface ComposableTool<P extends TProperties, D, S> {
  name: string;
  label: string;
  description: string;
  parameters: TObject<P>;
  promptGuidelines?: string[];
  renderShell?: "default" | "self";
  execute(
    toolCallId: string,
    params: Static<TObject<P>>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<D> | undefined,
    context: ExtensionContext
  ): Promise<AgentToolResult<D>>;
  renderCall?(
    args: Static<TObject<P>>,
    theme: Theme,
    context: ToolRenderContext<S, Static<TObject<P>>>
  ): Component;
  renderResult?(
    result: AgentToolResult<D>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ToolRenderContext<S, Static<TObject<P>>>
  ): Component;
}

interface RenderContextLike<A> {
  args: A;
  state: PresentationState;
  invalidate(): void;
  argsComplete?: boolean;
  cwd?: string;
  expanded?: boolean;
  isError?: boolean;
}

interface RenderOptionsLike {
  expanded?: boolean;
  isPartial?: boolean;
}

interface ComposeOptions {
  reasoningDescription: string;
  promptGuidelines?: string[];
}

interface ThemeLike {
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
  bold(text: string): string;
}

interface ToolDisplayDetails {
  toolDisplay?: {
    durationMs?: number;
    fullRead?: boolean;
    targetName?: string;
    ignoredOffset?: number;
    ignoredLimit?: number;
    writeDiff?: string;
  };
  diff?: string;
  diffOmitted?: boolean;
  truncation?: { truncated?: boolean };
  matchLimitReached?: number;
  resultLimitReached?: number;
  entryLimitReached?: number;
  rtkCompaction?: { savedChars: number };
}

export interface PresentationState {
  toolDisplayPresentation?: {
    durationMs?: number;
    error?: boolean;
    settled?: boolean;
    startedAt?: number;
    timer?: ReturnType<typeof setTimeout>;
    plannedPreview?: string;
    plannedPreviewError?: string;
    plannedPreviewKey?: string;
    plannedPreviewOmitted?: string;
  };
}

const GREP_FILE_PATTERN = /^(.+?):\d+(?::|$)/;
type TimerOwner = "file" | "rtk";
interface TimerRegistration {
  owner: TimerOwner;
  state: PresentationState;
}
const timers = new Map<ReturnType<typeof setTimeout>, TimerRegistration>();
type PresentedToolName = OwnedToolName | "bash";

const ICONS: Record<PresentedToolName, string> = {
  read: "📖",
  grep: "📖",
  find: "📖",
  ls: "📖",
  edit: "✏️",
  write: "✏️",
  bash: "⚡️",
};
const TOOL_NAME_COLORS: Record<PresentedToolName, string> = {
  read: "accent",
  grep: "accent",
  find: "accent",
  ls: "accent",
  edit: "warning",
  write: "warning",
  bash: "thinkingXhigh",
};
const FALLBACK_REASONING: Record<OwnedToolName, string> = {
  read: "Read file",
  grep: "Search files",
  find: "Find files",
  ls: "List directory",
  edit: "Edit file",
  write: "Write file",
};

function singleLine(value: string): string {
  return [...stripVTControlCharacters(value).replace(/\s+/gu, " ")]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
    })
    .join("")
    .trim();
}

function bashCommandPreview(value: string): string {
  const lines = stripVTControlCharacters(value)
    .split(/\r?\n|\r/gu)
    .map(singleLine)
    .filter(Boolean);
  const firstLine = lines[0] ?? "";
  return lines.length > 1
    ? `${firstLine} (+${lines.length - 1} lines)`
    : firstLine;
}

/** Add the shared required reasoning field while preserving delegated behavior. */
export function composeReasonedTool<
  P extends TProperties,
  D = unknown,
  S extends PresentationState = PresentationState,
>(
  tool: ComposableTool<P, D, S>,
  options: ComposeOptions
): ToolDefinition<ReasonedSchema<P>, D, S> {
  const parameters = Type.Object({
    reasoning: Type.String({ description: options.reasoningDescription }),
    ...tool.parameters.properties,
  }) as ReasonedSchema<P>;

  return {
    ...tool,
    parameters,
    promptGuidelines: [
      ...(tool.promptGuidelines ?? []),
      ...(options.promptGuidelines ?? []),
    ],
    renderCall: tool.renderCall
      ? (args, theme, context) => {
          const delegatedArgs = args as Static<TObject<P>>;
          return tool.renderCall?.(delegatedArgs, theme, {
            ...context,
            args: delegatedArgs,
          }) as Component;
        }
      : undefined,
    renderResult: tool.renderResult
      ? (result, renderOptions, theme, context) => {
          const delegatedArgs = context.args as Static<TObject<P>>;
          return tool.renderResult?.(result, renderOptions, theme, {
            ...context,
            args: delegatedArgs,
          }) as Component;
        }
      : undefined,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const parameterRecord = params as Static<TObject<P>> & {
        reasoning: string;
      };
      const { reasoning: _reasoning, ...delegated } = parameterRecord;
      const startedAt = Date.now();
      const result = await tool.execute(
        toolCallId,
        delegated as Static<TObject<P>>,
        signal,
        onUpdate,
        ctx
      );
      const priorDetails =
        result.details && typeof result.details === "object"
          ? (result.details as Record<string, unknown>)
          : {};
      const priorNamespace =
        priorDetails.toolDisplay && typeof priorDetails.toolDisplay === "object"
          ? (priorDetails.toolDisplay as Record<string, unknown>)
          : {};
      return {
        ...result,
        details: {
          ...priorDetails,
          toolDisplay: {
            ...priorNamespace,
            durationMs: Date.now() - startedAt,
          },
        } as D,
      };
    },
  };
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

export function cleanupToolDisplayTimers(owner?: TimerOwner): void {
  for (const [timer, registration] of timers) {
    if (owner !== undefined && registration.owner !== owner) {
      continue;
    }
    clearTimeout(timer);
    const presentation = stateFor(registration.state);
    if (presentation.timer === timer) {
      presentation.timer = undefined;
    }
    timers.delete(timer);
  }
}

function stateFor(
  state: PresentationState
): NonNullable<PresentationState["toolDisplayPresentation"]> {
  state.toolDisplayPresentation ??= {};
  return state.toolDisplayPresentation;
}

function stopTimer(state: PresentationState): void {
  const presentation = stateFor(state);
  if (presentation.timer) {
    clearTimeout(presentation.timer);
    timers.delete(presentation.timer);
    presentation.timer = undefined;
  }
}

function startTimer(
  state: PresentationState,
  invalidate: () => void,
  owner: TimerOwner
): void {
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
    startTimer(state, invalidate, owner);
  }, delay);
  timer.unref?.();
  presentation.timer = timer;
  timers.set(timer, { owner, state });
}

function editTargets(args: ArgsLike): string[] {
  if (args.text) {
    try {
      const operations = isPatchLikePayload(args.text)
        ? parsePatch(args.text)
        : parseRowScript(args.text);
      return [...new Set(operations.map((operation) => operation.path))];
    } catch {
      return [];
    }
  }
  const paths = [
    args.path,
    ...(args.multi ?? []).map((item) => item.path),
    ...(Array.isArray(args.edits) ? args.edits.map((item) => item.path) : []),
  ].filter((path): path is string => Boolean(path));
  const patchPaths = args.patch ? collectPatchCallPreviewFiles(args.patch) : [];
  return [...new Set([...paths, ...patchPaths])];
}

function editOperationSummary(args: ArgsLike): string {
  const mode =
    args.text && isPatchLikePayload(args.text) ? "patch" : "row edit";
  const targets = editTargets(args);
  const scope = targets.length === 1 ? "1 file" : `${targets.length} files`;
  const targetText = targets.length ? ` · ${targets.join(", ")}` : "";
  return `Apply ${mode} · ${scope}${targetText}`;
}

function targetFor(name: OwnedToolName, args: ArgsLike): string {
  if (name === "grep" || name === "find") {
    return `${args.pattern ?? "?"} in ${args.path ?? "."}`;
  }
  if (name === "edit") {
    return editTargets(args).join(", ") || "edit target";
  }
  return args.path ?? ".";
}

function firstText(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  const content = result.content?.find((item) => item.type === "text");
  return content?.text ?? "";
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const count = text.split("\n").length;
  return text.endsWith("\n") ? count - 1 : count;
}

function diffSummary(diff: string): string {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  return `+${additions}/-${deletions}`;
}

function warningBadges(details: ToolDisplayDetails): string {
  const badges: string[] = [];
  if (details.truncation?.truncated) {
    badges.push("truncated");
  }
  const limit =
    details.matchLimitReached ??
    details.resultLimitReached ??
    details.entryLimitReached;
  if (limit !== undefined) {
    badges.push(`limit ${limit}`);
  }
  if (details.rtkCompaction) {
    badges.push(`RTK saved ${details.rtkCompaction.savedChars}`);
  }
  return badges.map((badge) => ` [${badge}]`).join("");
}

function summaryFor(
  name: OwnedToolName,
  args: ArgsLike,
  result: {
    content?: Array<{ type: string; text?: string }>;
    details?: unknown;
    isError?: boolean;
  }
): string {
  const output = firstText(result);
  const details = (result.details ?? {}) as ToolDisplayDetails;
  if (result.isError) {
    return output.split("\n").find(Boolean) ?? `${name} failed`;
  }
  if (details.toolDisplay?.fullRead) {
    const ignored =
      details.toolDisplay.ignoredOffset !== undefined ||
      details.toolDisplay.ignoredLimit !== undefined;
    return `${countLines(output)} lines · full read ${details.toolDisplay.targetName ?? "target"}${ignored ? " [pagination ignored]" : ""}`;
  }
  let summary: string;
  if (name === "read") {
    summary =
      result.content?.[0]?.type === "image"
        ? "image loaded"
        : `${countLines(output)} lines`;
  } else if (name === "write") {
    summary = `${countLines(args.content ?? "")} lines written`;
  } else if (name === "edit") {
    const diff = details.diff ?? details.toolDisplay?.writeDiff ?? "";
    summary =
      details.diffOmitted || diff.startsWith("[diff omitted:")
        ? "diff omitted"
        : diffSummary(diff);
  } else if (name === "grep") {
    const matchRows = output
      ? output
          .split("\n")
          .map((line) => ({ line, match: line.match(GREP_FILE_PATTERN) }))
          .filter(
            (row): row is { line: string; match: RegExpMatchArray } =>
              row.match !== null
          )
      : [];
    const files = new Set(matchRows.map((row) => row.match[1]));
    summary = `${matchRows.length} matches · ${files.size} files`;
  } else if (name === "find") {
    summary = `${countLines(output)} files`;
  } else {
    summary = `${countLines(output)} entries`;
  }
  return `${summary}${warningBadges(details)}`;
}

function fitTail(
  text: string,
  width: number,
  measuredWidth = visibleWidth(text)
): string {
  const textWidth = measuredWidth;
  if (textWidth <= width) {
    return text;
  }
  if (width <= 1) {
    return truncateToWidth(text, width, "");
  }
  const requestedTailWidth = Math.max(1, Math.floor((width - 1) / 2));
  const tail = sliceByColumn(
    text,
    textWidth - requestedTailWidth,
    requestedTailWidth,
    true
  );
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
  theme: ThemeLike,
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
  const fitted = fitTail(text, width, textWidth);
  const fittedWidth = textWidth <= width ? textWidth : visibleWidth(fitted);
  return theme.bg(token, fitted + " ".repeat(Math.max(0, width - fittedWidth)));
}

function buildPlannedDiff(
  changes: Awaited<ReturnType<typeof buildUnifiedEditPlan>>["changes"]
): { omitted?: string; preview?: string } {
  const inputBytes = changes.reduce(
    (total, change) =>
      total +
      Buffer.byteLength(change.oldText, "utf8") +
      Buffer.byteLength(change.newText, "utf8"),
    0
  );
  const inputLines = changes.reduce(
    (total, change) =>
      total +
      change.oldText.split("\n").length +
      change.newText.split("\n").length,
    0
  );
  const omitted = `exceeds ${MAX_DIFF_BYTES} bytes / ${MAX_DIFF_LINES} lines preview limit`;
  if (inputBytes > MAX_DIFF_BYTES || inputLines > MAX_DIFF_LINES) {
    return { omitted };
  }
  const preview = changes
    .map((change) =>
      createTwoFilesPatch(
        change.kind === "add" ? "/dev/null" : change.path,
        change.kind === "delete" ? "/dev/null" : change.path,
        change.oldText,
        change.newText,
        undefined,
        undefined,
        { context: 4 }
      )
    )
    .join("\n");
  if (
    Buffer.byteLength(preview, "utf8") > MAX_DIFF_BYTES ||
    preview.split("\n").length > MAX_DIFF_LINES
  ) {
    return { omitted };
  }
  return { preview };
}

function requestEditPreview(
  args: ArgsLike,
  context: Pick<
    RenderContextLike<ArgsLike>,
    "argsComplete" | "cwd" | "invalidate" | "state"
  >
): void {
  if (!(context.argsComplete && typeof args.text === "string")) {
    return;
  }
  const cwd = context.cwd ?? process.cwd();
  const key = `${cwd}\u0000${args.text}`;
  const state = stateFor(context.state);
  if (state.plannedPreviewKey === key) {
    return;
  }
  state.plannedPreviewKey = key;
  state.plannedPreview = undefined;
  state.plannedPreviewError = undefined;
  state.plannedPreviewOmitted = undefined;
  buildUnifiedEditPlan(args.text, cwd)
    .then((plan) => {
      if (state.plannedPreviewKey !== key || state.settled) {
        return;
      }
      const result = buildPlannedDiff(plan.changes);
      state.plannedPreview = result.preview;
      state.plannedPreviewOmitted = result.omitted;
      context.invalidate();
    })
    .catch((error: unknown) => {
      if (state.plannedPreviewKey !== key || state.settled) {
        return;
      }
      state.plannedPreviewError =
        error instanceof Error ? error.message : String(error);
      context.invalidate();
    });
}

function plannedPreviewLines(
  presentationState: PresentationState,
  theme: ThemeLike,
  width: number
): string[] {
  const state = stateFor(presentationState);
  if (state.settled) {
    return [];
  }
  if (state.plannedPreview) {
    const heading = theme.fg("dim", "┊   planned diff");
    return [heading, ...state.plannedPreview.split("\n")].map((line) =>
      truncateToWidth(line, width, "")
    );
  }
  if (state.plannedPreviewOmitted) {
    return [
      truncateToWidth(
        theme.fg(
          "warning",
          `┊   planned diff omitted: ${state.plannedPreviewOmitted}`
        ),
        width,
        ""
      ),
    ];
  }
  if (state.plannedPreviewError) {
    return [
      truncateToWidth(
        theme.fg(
          "warning",
          `┊   preview unavailable: ${singleLine(state.plannedPreviewError)}`
        ),
        width,
        ""
      ),
    ];
  }
  return [theme.fg("dim", "┊   planning preview…")];
}

class HeaderComponent implements Component {
  private readonly args: ArgsLike;
  private readonly argsComplete: boolean;
  private readonly expanded: boolean;
  private readonly name: PresentedToolName;
  private readonly state: PresentationState;
  private readonly theme: ThemeLike;

  constructor(
    name: PresentedToolName,
    args: ArgsLike,
    theme: ThemeLike,
    state: PresentationState,
    invalidateCallback: () => void,
    expanded = false,
    argsComplete = true
  ) {
    this.name = name;
    this.args = args;
    this.argsComplete = argsComplete;
    this.expanded = expanded;
    this.theme = theme;
    this.state = state;
    startTimer(state, invalidateCallback, name === "bash" ? "rtk" : "file");
  }
  invalidate(): void {
    return;
  }
  render(width: number): string[] {
    const state = stateFor(this.state);
    let status = "•";
    let statusToken = "warning";
    if (state.settled) {
      status = state.error ? "×" : "✓";
      statusToken = state.error ? "error" : "success";
    }
    let target: string;
    if (this.name === "bash") {
      target = bashCommandPreview(this.args.command ?? "") || "bash command";
    } else {
      target = singleLine(targetFor(this.name, this.args));
      if (this.name === "edit" && !this.argsComplete) {
        target = "edit target";
      }
    }
    let headline =
      singleLine(this.args.reasoning ?? "") ||
      (this.name === "bash" ? target : FALLBACK_REASONING[this.name]);
    if (this.name === "edit") {
      headline = this.argsComplete
        ? editOperationSummary(this.args)
        : "Apply edit";
    }
    const color = TOOL_NAME_COLORS[this.name];
    const first = `${this.theme.fg("dim", "┊")} ${this.theme.fg(statusToken, status)} ${this.theme.fg(color, ICONS[this.name])} ${this.theme.fg(color, this.theme.bold(this.name))} ${headline}`;
    const lines = [first];
    if (!state.settled) {
      const elapsed = Date.now() - (state.startedAt ?? Date.now());
      lines.push(
        fitMiddle(
          this.theme.fg("dim", "┊   "),
          target,
          ` ${this.theme.fg("dim", `→ ${formatToolDuration(elapsed)}`)}`,
          width
        )
      );
    }
    const previewLines =
      this.name === "edit" && this.expanded && this.argsComplete
        ? plannedPreviewLines(this.state, this.theme, width)
        : [];
    return [...lines, ...previewLines].map((line) =>
      backgroundLine(
        line,
        width,
        this.theme,
        state.error === true,
        state.settled === true
      )
    );
  }
}

class ResultComponent implements Component {
  private readonly body: Component | undefined;
  private readonly error: boolean;
  private readonly settled: boolean;
  private readonly showSummary: boolean;
  private readonly text: string | ((width: number) => string);
  private readonly theme: ThemeLike;

  constructor(
    text: string | ((width: number) => string),
    theme: ThemeLike,
    error: boolean,
    body?: Component,
    settled = true,
    showSummary = true
  ) {
    this.text = text;
    this.theme = theme;
    this.error = error;
    this.body = body;
    this.settled = settled;
    this.showSummary = showSummary;
  }
  invalidate(): void {
    this.body?.invalidate();
  }
  render(width: number): string[] {
    let bodyLines: string[] | undefined;
    let bodyStart = 0;
    if (this.body instanceof ResultBodyComponent) {
      const body = this.body.renderForParent(width);
      bodyLines = body.lines;
      bodyStart = body.start;
    } else {
      bodyLines = this.body?.render(width);
    }

    const output: string[] = [];
    if (this.showSummary) {
      const text =
        typeof this.text === "function" ? this.text(width) : this.text;
      output.push(
        backgroundLine(text, width, this.theme, this.error, this.settled)
      );
    }
    const lines = bodyLines ?? [];
    for (let index = bodyStart; index < lines.length; index += 1) {
      output.push(
        backgroundLine(
          lines[index] ?? "",
          width,
          this.theme,
          this.error,
          this.settled
        )
      );
    }
    return output;
  }
}

class ResultBodyComponent implements Component {
  private readonly component: Component;
  private readonly dropsSummary: boolean;

  constructor(component: Component, dropsSummary: boolean) {
    this.component = component;
    this.dropsSummary = dropsSummary;
  }
  invalidate(): void {
    this.component.invalidate();
  }
  render(width: number): string[] {
    const { lines, start } = this.renderForParent(width);
    if (start === 0) {
      return lines;
    }
    const output = new Array<string>(Math.max(0, lines.length - start));
    for (let index = 0; index < output.length; index += 1) {
      output[index] = lines[index + start] ?? "";
    }
    return output;
  }
  renderForParent(width: number): { lines: string[]; start: number } {
    return {
      lines: this.component.render(width),
      start: this.dropsSummary ? 1 : 0,
    };
  }
}

/** Keep an existing expanded renderer full-width beneath the shared header. */
export function toolResultBody(
  component: Component,
  dropsSummary = false
): Component {
  return new ResultBodyComponent(component, dropsSummary);
}

export function renderBashToolCall(
  args: ArgsLike,
  theme: ThemeLike,
  context: Pick<RenderContextLike<ArgsLike>, "state" | "invalidate">
): Component {
  return new HeaderComponent(
    "bash",
    args,
    theme,
    context.state,
    context.invalidate
  );
}

export function renderBashToolResult(
  result: ToolResultLike,
  options: RenderOptionsLike,
  theme: ThemeLike,
  context: Pick<RenderContextLike<ArgsLike>, "args" | "state" | "isError">,
  body?: Component
): Component {
  const state = stateFor(context.state);
  const details = (result.details ?? {}) as ToolDisplayDetails;
  const durationMs =
    details.toolDisplay?.durationMs ??
    (state.startedAt === undefined ? 0 : Date.now() - state.startedAt);
  const error = result.isError === true || context.isError === true;
  if (!options.isPartial) {
    state.settled = true;
    state.error = error;
    state.durationMs = durationMs;
    stopTimer(context.state);
  }
  const command =
    bashCommandPreview(context.args.command ?? "") || "bash command";
  let status = options.isPartial ? "running" : "done";
  if (error) {
    status = "error";
  }
  const badges = warningBadges(details);
  const token = error ? "error" : "dim";
  return new ResultComponent(
    (width) =>
      fitMiddle(
        theme.fg("dim", "┊   "),
        command,
        ` ${theme.fg("dim", "→")} ${theme.fg(token, `${status} in ${formatToolDuration(durationMs)}${badges}`)}`,
        width
      ),
    theme,
    error,
    body,
    !options.isPartial,
    !options.isPartial
  );
}

export function renderOwnedToolCall(
  name: OwnedToolName,
  args: ArgsLike,
  theme: ThemeLike,
  context: Pick<
    RenderContextLike<ArgsLike>,
    "argsComplete" | "cwd" | "expanded" | "invalidate" | "state"
  >
): Component {
  if (name === "edit" && context.expanded === true) {
    requestEditPreview(args, context);
  }
  return new HeaderComponent(
    name,
    args,
    theme,
    context.state,
    context.invalidate,
    name === "edit" && context.expanded === true,
    context.argsComplete !== false
  );
}

export function renderOwnedToolResult(
  name: OwnedToolName,
  result: ToolResultLike,
  options: RenderOptionsLike,
  theme: ThemeLike,
  context: Pick<RenderContextLike<ArgsLike>, "args" | "state" | "isError">,
  body?: Component
): Component {
  const state = stateFor(context.state);
  const error = result.isError === true || context.isError === true;
  const details = (result.details ?? {}) as ToolDisplayDetails;
  if (!options.isPartial) {
    state.settled = true;
    state.error = error;
    state.durationMs =
      details.toolDisplay?.durationMs ??
      (state.startedAt === undefined ? 0 : Date.now() - state.startedAt);
    stopTimer(context.state);
  }
  const target = singleLine(targetFor(name, context.args));
  const resultWithError = error ? { ...result, isError: true } : result;
  const baseSummary = singleLine(
    summaryFor(name, context.args, resultWithError)
  );
  const summary =
    name === "edit"
      ? `${error ? "error" : "applied"} in ${formatToolDuration(state.durationMs ?? 0)} · ${baseSummary}`
      : baseSummary;
  const token = error ? "error" : "dim";
  return new ResultComponent(
    (width) =>
      fitMiddle(
        theme.fg("dim", "┊   "),
        target,
        ` ${theme.fg("dim", "→")} ${theme.fg(token, summary)}`,
        width
      ),
    theme,
    error,
    body,
    !options.isPartial
  );
}
