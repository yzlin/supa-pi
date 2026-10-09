import { stripVTControlCharacters } from "node:util";

import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const PANE_LINES = 3;
const REPORT_LINES = 5;

interface ThemeLike {
  bg(token: string, text: string): string;
  bold(text: string): string;
  fg(token: string, text: string): string;
}
export interface CardArgs {
  task?: string;
  agent?: string;
  model?: string;
  thinking?: string;
}
interface CardState {
  card?: {
    startedAt?: number;
    status?: "queued" | "running";
    settled?: boolean;
    error?: boolean;
    durationMs?: number;
    model?: string;
    thinking?: string;
  };
}
interface ResultLike {
  content?: { type: string; text?: string }[];
  details?: unknown;
  isError?: boolean;
}
interface Update {
  status: "queued" | "running";
  text: string;
  attachCommand?: string;
}
interface Final {
  runId: string;
  provider: string;
  model: string;
  thinking: string;
  output: string;
  structuredOutput?: unknown;
  resultPath: string;
  sessionFile?: string;
  durationMs?: number;
}

function safe(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\t/gu, "    ")
    .replace(/\p{Cc}/gu, (control) => (control === "\n" ? control : ""));
}
function singleLine(text: string | undefined): string {
  return safe(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}
export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 1) {
    return "<1s";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}
function asUpdate(details: unknown): Update | undefined {
  if (
    details &&
    typeof details === "object" &&
    "status" in details &&
    (details.status === "queued" || details.status === "running") &&
    "text" in details &&
    typeof details.text === "string"
  ) {
    return details as Update;
  }
}
function asFinal(details: unknown): Final | undefined {
  if (
    details &&
    typeof details === "object" &&
    "runId" in details &&
    "output" in details &&
    typeof details.output === "string" &&
    "model" in details &&
    typeof details.model === "string"
  ) {
    return details as Final;
  }
}
function stateFor(state: CardState): NonNullable<CardState["card"]> {
  state.card ??= {};
  return state.card;
}
function line(
  text: string,
  width: number,
  theme: ThemeLike,
  card: NonNullable<CardState["card"]>,
): string {
  let token = "toolPendingBg";
  if (card.error) {
    token = "toolErrorBg";
  } else if (card.settled) {
    token = "toolSuccessBg";
  }
  const fitted = truncateToWidth(text, width, "…");
  return theme.bg(
    token,
    fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted))),
  );
}

/** Lines read shared state at draw time, so result updates restyle the header. */
function cardComponent(
  lines: (width: number) => string[],
  theme: ThemeLike,
  state: CardState,
): Component {
  return {
    invalidate() {
      return;
    },
    render: (width) =>
      lines(width).map((text) => line(text, width, theme, stateFor(state))),
  };
}

function headerLines(
  args: CardArgs,
  theme: ThemeLike,
  card: NonNullable<CardState["card"]>,
): string[] {
  let glyph = theme.fg("warning", "•");
  let status = "starting";
  if (card.settled) {
    glyph = card.error ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const took =
      card.durationMs === undefined ? "" : formatDuration(card.durationMs);
    status = card.error
      ? `failed${took ? ` after ${took}` : ""}`
      : `done${took ? ` in ${took}` : ""}`;
  } else if (card.status === "queued") {
    status = theme.fg("warning", "queued for a slot");
  } else if (card.status === "running") {
    status = `running ${formatDuration(Date.now() - (card.startedAt ?? Date.now()))}`;
  }
  const agent = singleLine(args.agent);
  const model = singleLine(card.model ?? args.model);
  const thinking = singleLine(card.thinking ?? args.thinking);
  const identity = [
    agent ? theme.bold(agent) : "",
    [model, thinking ? theme.fg("dim", thinking) : ""]
      .filter(Boolean)
      .join(" "),
  ]
    .filter(Boolean)
    .join(theme.fg("dim", " · "));
  const head = `${theme.fg("dim", "┊")} ${glyph} ${theme.fg("thinkingHigh", theme.bold("🤖 subagent"))}${identity ? ` ${identity}` : ""} ${theme.fg(card.error ? "error" : "dim", `→ ${status}`)}`;
  const task = `${theme.fg("dim", "┊")}   ${singleLine(args.task) || "task"}`;
  return [head, task];
}

function contentText(result: ResultLike): string {
  return safe(
    (result.content ?? [])
      .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
      .join("\n"),
  ).trim();
}
function reportLines(
  text: string,
  width: number,
  expanded: boolean,
  token: string,
  theme: ThemeLike,
): string[] {
  const wrapped = text
    .split("\n")
    .flatMap((row) => wrapTextWithAnsi(row, Math.max(1, width)));
  if (expanded || wrapped.length <= REPORT_LINES) {
    return wrapped.map((row) => theme.fg(token, row));
  }
  return [
    ...wrapped.slice(0, REPORT_LINES).map((row) => theme.fg(token, row)),
    theme.fg(
      "dim",
      `… ${wrapped.length - REPORT_LINES} more lines (Ctrl+O to expand)`,
    ),
  ];
}

export function renderSubagentCall(
  args: CardArgs,
  theme: ThemeLike,
  context: { state: CardState },
): Component {
  stateFor(context.state).startedAt ??= Date.now();
  return cardComponent(
    () => headerLines(args, theme, stateFor(context.state)),
    theme,
    context.state,
  );
}

export function renderSubagentResult(
  result: ResultLike,
  options: { expanded: boolean; isPartial: boolean },
  theme: ThemeLike,
  context: { state: CardState; isError?: boolean },
): Component {
  const card = stateFor(context.state);
  const update = options.isPartial ? asUpdate(result.details) : undefined;
  if (options.isPartial) {
    if (update) {
      card.status = update.status;
    }
    return cardComponent(
      (width) => {
        if (update?.status !== "running") {
          return [];
        }
        const activity = safe(update.text)
          .split("\n")
          .filter((row) => row.trim())
          .join("\n");
        const tail = truncateToVisualLines(
          activity,
          PANE_LINES,
          Math.max(1, width - 4),
          0,
          "end",
        ).visualLines;
        return [
          ...tail.map(
            (row, index) =>
              `${theme.fg("dim", "  │ ")}${theme.fg(index === tail.length - 1 ? "accent" : "toolOutput", row)}`,
          ),
          ...(update.attachCommand
            ? [theme.fg("dim", `  attach: ${safe(update.attachCommand)}`)]
            : []),
        ];
      },
      theme,
      context.state,
    );
  }
  const final = asFinal(result.details);
  card.settled = true;
  card.error = result.isError === true || context.isError === true || !final;
  card.durationMs =
    final?.durationMs ??
    card.durationMs ??
    (card.startedAt === undefined ? undefined : Date.now() - card.startedAt);
  if (final) {
    card.model = final.model;
    card.thinking = final.thinking;
  }
  return cardComponent(
    (width) => {
      if (!final) {
        return reportLines(
          contentText(result) || "Subagent failed.",
          width,
          options.expanded,
          "error",
          theme,
        );
      }
      let report = safe(final.output).trim();
      if (!report) {
        report =
          final.structuredOutput === undefined
            ? "(no text output)"
            : "StructuredOutput validated; saved in evidence.";
      }
      const lines = reportLines(
        report,
        width,
        options.expanded,
        "toolOutput",
        theme,
      );
      if (!options.expanded) {
        return lines;
      }
      return [
        ...lines,
        "",
        ...[
          `run      ${final.runId}`,
          `model    ${final.provider}/${final.model} (${final.thinking})`,
          `evidence ${final.resultPath}`,
          ...(final.sessionFile ? [`session  ${final.sessionFile}`] : []),
        ]
          .flatMap((row) => wrapTextWithAnsi(safe(row), Math.max(1, width)))
          .map((row) => theme.fg("dim", row)),
      ];
    },
    theme,
    context.state,
  );
}
