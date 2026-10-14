import { stripVTControlCharacters } from "node:util";

import {
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type { Assignment, Checkpoint, ExecutionLedger } from "./schema";

const ERROR_LINES = 5;

interface ThemeLike {
  bg(token: string, text: string): string;
  bold(text: string): string;
  fg(token: string, text: string): string;
}
export interface CheckpointArgs {
  action?: Checkpoint["action"];
  assignmentId?: string;
  assignments?: unknown[];
  plan?: string;
  approval?: string;
  passed?: boolean;
  evidence?: string[];
  blockers?: string[];
  newAssignmentId?: string;
  task?: string;
}
interface CardState {
  checkpoint?: { settled?: boolean; error?: boolean; status?: string };
}
interface ResultLike {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
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
function stateFor(state: CardState): NonNullable<CardState["checkpoint"]> {
  state.checkpoint ??= {};
  return state.checkpoint;
}
function contentText(result: ResultLike): string {
  return safe(
    (result.content ?? [])
      .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
      .join("\n"),
  ).trim();
}
function isLedger(value: unknown): value is ExecutionLedger {
  return (
    !!value &&
    typeof value === "object" &&
    "assignments" in value &&
    Array.isArray(value.assignments)
  );
}
/** Restored sessions may lack structuredContent; content carries the same JSON. */
function readOutput(
  result: ResultLike,
): { ledger: ExecutionLedger; dispatchPrefix: string | null } | undefined {
  let output = result.structuredContent;
  if (!(output && typeof output === "object" && "ledger" in output)) {
    try {
      output = JSON.parse(contentText(result));
    } catch {
      return;
    }
  }
  if (
    output &&
    typeof output === "object" &&
    "ledger" in output &&
    isLedger(output.ledger)
  ) {
    const prefix =
      "dispatchPrefix" in output && typeof output.dispatchPrefix === "string"
        ? output.dispatchPrefix
        : null;
    return { ledger: output.ledger, dispatchPrefix: prefix };
  }
}

function effective(ledger: ExecutionLedger): Assignment[] {
  return ledger.assignments.filter(
    (assignment) => assignment.supersededBy === null,
  );
}
function progress(ledger: ExecutionLedger, theme: ThemeLike): string {
  const live = effective(ledger);
  const done = live.filter((a) => a.status === "completed").length;
  return theme.fg("dim", ` · ${done}/${live.length}`);
}

function statusText(
  args: CheckpointArgs,
  ledger: ExecutionLedger,
  dispatchPrefix: string | null,
  theme: ThemeLike,
): string {
  const arrow = theme.fg("dim", "→ ");
  const tail = progress(ledger, theme);
  switch (args.action) {
    case "accept":
      return `${arrow}${theme.fg("dim", "accepted")}${tail}`;
    case "start":
      return `${arrow}${theme.fg("dim", dispatchPrefix ? "running · prefix issued" : "running")}${tail}`;
    case "verify":
      return args.passed
        ? `${arrow}${theme.fg("success", "passed")}${tail}`
        : `${arrow}${theme.fg("error", "not passed")}${tail}`;
    case "block":
      return `${arrow}${theme.fg("error", `"${singleLine(args.blockers?.[0]) || "blocked"}"`)}${tail}`;
    case "repair":
      return `${arrow}${theme.fg("dim", `repair ${singleLine(args.newAssignmentId)}`)}${tail}`;
    case "stop":
      return `${arrow}${theme.fg("dim", "stopped")}${tail}`;
    case "inspect":
    case undefined:
      return `${arrow}${theme.fg("dim", "ledger")}${tail}`;
  }
}

function headerLine(
  args: CheckpointArgs,
  theme: ThemeLike,
  card: NonNullable<CardState["checkpoint"]>,
): string {
  let glyph = theme.fg("warning", "•");
  if (card.settled) {
    glyph = card.error ? theme.fg("error", "✗") : theme.fg("success", "✓");
  }
  const action = singleLine(args.action) || "checkpoint";
  let target = "";
  if (args.assignmentId) {
    target = ` ${theme.bold(singleLine(args.assignmentId))}`;
  } else if (args.action === "accept" && args.assignments) {
    target = ` ${theme.fg("muted", `${args.assignments.length} assignments`)}`;
  }
  const status = card.status ?? theme.fg("dim", "→ pending");
  return `${theme.fg("dim", "┊")} ${glyph} ${theme.fg("accent", theme.bold("🎯 checkpoint"))} ${action}${target} ${status}`;
}

function note(
  assignment: Assignment,
  ledger: ExecutionLedger,
  theme: ThemeLike,
): string {
  switch (assignment.status) {
    case "completed":
      return `${theme.fg("success", "✓")} ${theme.fg("muted", singleLine(assignment.evidence[0]))}`;
    case "blocked":
      return theme.fg("error", singleLine(assignment.blockers[0]) || "blocked");
    case "running":
      return theme.fg(
        "muted",
        assignment.attemptId ? `attempt ${assignment.attemptId}` : "running",
      );
    case "reverify":
      return theme.fg("warning", "reverify");
    case "pending": {
      const done = new Set(
        effective(ledger)
          .filter((a) => a.status === "completed")
          .map((a) => a.lineageId),
      );
      const byId = new Map(ledger.assignments.map((a) => [a.id, a]));
      const waiting = assignment.dependencies.filter(
        (dep) => !done.has(byId.get(dep)?.lineageId ?? dep),
      );
      return waiting.length > 0
        ? theme.fg("dim", `needs: ${waiting.join(", ")}`)
        : "";
    }
  }
}

const GLYPHS: Record<Assignment["status"], [string, string]> = {
  completed: ["●", "success"],
  running: ["◐", "warning"],
  reverify: ["↻", "warning"],
  blocked: ["✗", "error"],
  pending: ["○", "dim"],
};

function boardLines(
  ledger: ExecutionLedger,
  focus: string | undefined,
  theme: ThemeLike,
): string[] {
  const live = effective(ledger);
  const idWidth = Math.max(
    0,
    ...live.map((a) => visibleWidth(singleLine(a.id))),
  );
  const scopeWidth = Math.max(
    0,
    ...live.map((a) => visibleWidth(scopeText(a))),
  );
  return live.map((assignment) => {
    const [glyph, token] = GLYPHS[assignment.status];
    const id = singleLine(assignment.id).padEnd(idWidth);
    const scope = scopeText(assignment).padEnd(scopeWidth);
    return [
      `${theme.fg(token, glyph)} ${assignment.id === focus ? theme.bold(id) : theme.fg("muted", id)}`,
      theme.fg("dim", scope),
      note(assignment, ledger, theme),
    ]
      .join("  ")
      .trimEnd();
  });
}
function scopeText(assignment: Assignment): string {
  const [first = "", ...rest] = assignment.scope.map(singleLine);
  return rest.length > 0 ? `${first} +${rest.length}` : first;
}

function detailLines(args: CheckpointArgs, ledger: ExecutionLedger): string[] {
  const label = (name: string, value: string | undefined) =>
    value ? [`${name}: ${safe(value).trim()}`] : [];
  const join = (items: string[] | undefined) =>
    items && items.length > 0 ? items.map(singleLine).join(" · ") : undefined;
  switch (args.action) {
    case "accept":
      return [...label("plan", args.plan), ...label("approval", args.approval)];
    case "start": {
      const assignment = ledger.assignments.find(
        (a) => a.id === args.assignmentId,
      );
      return label("task", assignment?.task);
    }
    case "verify":
      return [
        ...label("evidence", join(args.evidence)),
        ...label("blockers", join(args.blockers)),
      ];
    case "block":
      return label("blockers", join(args.blockers));
    case "repair":
      return label("task", args.task);
    case "inspect":
    case "stop":
    case undefined:
      return [];
  }
}

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
      lines(width).map((text) => {
        const card = stateFor(state);
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
      }),
  };
}

export function renderCheckpointCall(
  args: CheckpointArgs,
  theme: ThemeLike,
  context: { state: CardState },
): Component {
  return cardComponent(
    () => [headerLine(args, theme, stateFor(context.state))],
    theme,
    context.state,
  );
}

export function renderCheckpointResult(
  result: ResultLike,
  options: { expanded: boolean },
  theme: ThemeLike,
  context: { state: CardState; args: CheckpointArgs; isError?: boolean },
): Component {
  const card = stateFor(context.state);
  const output =
    result.isError || context.isError ? undefined : readOutput(result);
  card.settled = true;
  card.error = !output;
  if (!output) {
    card.status = theme.fg("error", "→ failed");
    return cardComponent(
      (width) => {
        const rows = (contentText(result) || "Checkpoint failed.")
          .split("\n")
          .flatMap((row) => wrapTextWithAnsi(row, Math.max(1, width - 4)))
          .map((row) => `${theme.fg("dim", "┊")}   ${theme.fg("error", row)}`);
        return options.expanded ? rows : rows.slice(0, ERROR_LINES);
      },
      theme,
      context.state,
    );
  }
  const { ledger, dispatchPrefix } = output;
  card.status = statusText(context.args, ledger, dispatchPrefix, theme);
  return cardComponent(
    (width) => {
      if (!options.expanded) {
        return [];
      }
      const gutter = `${theme.fg("dim", "┊")}   `;
      const details = detailLines(context.args, ledger)
        .flatMap((row) => row.split("\n"))
        .flatMap((row) => wrapTextWithAnsi(row, Math.max(1, width - 4)))
        .map((row) => theme.fg("muted", row));
      return [
        ...details,
        ...boardLines(ledger, context.args.assignmentId, theme),
      ].map((row) => gutter + row);
    },
    theme,
    context.state,
  );
}
