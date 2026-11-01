import { stripVTControlCharacters } from "node:util";

import {
  type Component,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { isReviewProgressDetails, type ReviewProgressRow } from "./progress";

interface ThemeLike {
  bold(text: string): string;
  fg(token: string, text: string): string;
}
interface ResultLike {
  content?: { type: string; text?: string }[];
  details?: unknown;
  isError?: boolean;
}
interface RenderState {
  rows?: ReviewProgressRow[];
}

function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/\p{Cc}/gu, "");
}

function formatDuration(milliseconds: number): string {
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

function statusText(row: ReviewProgressRow, theme: ThemeLike): string {
  switch (row.status) {
    case "running":
      return `running ${formatDuration(Date.now() - (row.startedAt ?? Date.now()))}`;
    case "queued":
      return theme.fg("warning", "queued for a slot");
    case "waiting":
      return theme.fg("dim", "waiting");
    case "done":
      return row.durationMs === undefined
        ? "done"
        : `done in ${formatDuration(row.durationMs)}`;
    case "failed":
      return theme.fg(
        "error",
        row.durationMs === undefined
          ? "failed"
          : `failed after ${formatDuration(row.durationMs)}`,
      );
  }
}

function glyph(row: ReviewProgressRow, theme: ThemeLike): string {
  if (row.status === "done") {
    return theme.fg("success", "✓");
  }
  if (row.status === "failed") {
    return theme.fg("error", "✗");
  }
  if (row.status === "running") {
    return theme.fg("warning", "•");
  }
  return theme.fg("dim", "·");
}

function summary(rows: ReviewProgressRow[]): string {
  const count = (status: ReviewProgressRow["status"]) =>
    rows.filter((row) => row.status === status).length;
  const pending = count("queued") + count("waiting");
  return [
    `${rows.length} children`,
    `${count("done")} done`,
    `${count("running")} running`,
    pending ? `${pending} pending` : "",
    count("failed") ? `${count("failed")} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function reviewProgressLines(
  rows: ReviewProgressRow[],
  width: number,
  theme: ThemeLike,
  pad = 0,
): string[] {
  const indent = " ".repeat(pad);
  const room = Math.max(1, width - pad);
  const fit = (text: string) => indent + truncateToWidth(text, room, "…");
  const agentWidth = Math.max(...rows.map((row) => clean(row.agent).length));
  const lines = [fit(theme.fg("dim", summary(rows)))];
  for (const row of rows) {
    lines.push(
      fit(
        `${glyph(row, theme)} ${theme.bold(clean(row.agent).padEnd(agentWidth))}  ${clean(row.model)} ${theme.fg("dim", clean(row.thinking))}  ${theme.fg("dim", "→")} ${statusText(row, theme)}`,
      ),
    );
    if (row.status !== "running") {
      continue;
    }
    for (const [index, text] of row.tail.entries()) {
      lines.push(
        fit(
          `${theme.fg("dim", "    │ ")}${theme.fg(index === row.tail.length - 1 ? "accent" : "toolOutput", clean(text))}`,
        ),
      );
    }
    if (row.attachCommand) {
      lines.push(
        ...wrapTextWithAnsi(
          clean(row.attachCommand),
          Math.max(1, room - 4),
        ).map((text) => `${indent}    ${text}`),
      );
    }
  }
  return lines;
}

export function renderReviewRunCall(
  theme: ThemeLike,
  context: { outputPad?: number },
): Component {
  return {
    invalidate() {
      return;
    },
    render: () => [
      `${" ".repeat(context.outputPad ?? 0)}${theme.fg("toolTitle", theme.bold("review_run"))}`,
    ],
  };
}

export function renderReviewRunResult(
  result: ResultLike,
  options: { isPartial: boolean },
  theme: ThemeLike,
  context: { state: RenderState; isError?: boolean; outputPad?: number },
): Component {
  if (isReviewProgressDetails(result.details)) {
    context.state.rows = result.details.reviewProgress;
  }
  const pad = context.outputPad ?? 0;
  return {
    invalidate() {
      return;
    },
    render: (width) => {
      const rows = context.state.rows ?? [];
      const lines = rows.length
        ? reviewProgressLines(rows, width, theme, pad)
        : [];
      if (options.isPartial) {
        return lines;
      }
      const text = clean(
        (result.content ?? [])
          .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
          .join(" "),
      ).trim();
      const failed = result.isError === true || context.isError === true;
      return [
        ...lines,
        ...wrapTextWithAnsi(text, Math.max(1, width - pad)).map(
          (row) =>
            `${" ".repeat(pad)}${theme.fg(failed ? "error" : "dim", row)}`,
        ),
      ];
    },
  };
}
