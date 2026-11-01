import { stripVTControlCharacters } from "node:util";

import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";

const TAIL_LINES = 3;
export const REVIEW_PROGRESS_FLUSH_MS = 250;

export interface ReviewProgressRow {
  agent: string;
  model: string;
  thinking: string;
  status: "waiting" | "queued" | "running" | "done" | "failed";
  startedAt?: number;
  durationMs?: number;
  tail: string[];
  attachCommand?: string;
}

export interface ReviewProgressDetails {
  reviewProgress: ReviewProgressRow[];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function tailLines(text: string): string[] {
  return stripVTControlCharacters(text)
    .replace(/\t/gu, "    ")
    .replace(/\p{Cc}/gu, (control) => (control === "\n" ? control : ""))
    .split("\n")
    .map((row) => row.trimEnd())
    .filter((row) => row.trim())
    .slice(-TAIL_LINES);
}

function activeText(rows: ReviewProgressRow[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.status !== "running" && row.status !== "queued") {
      continue;
    }
    lines.push(`${row.status}: ${row.agent}`);
    if (row.attachCommand) {
      lines.push(row.attachCommand);
    }
  }
  return lines.length ? lines.join("\n") : "Review children settled.";
}

export function isReviewProgressDetails(
  value: unknown,
): value is ReviewProgressDetails {
  return record(value) && Array.isArray(value.reviewProgress);
}

/**
 * Merges concurrent child updates into one stable per-child snapshot.
 * Status changes flush at once; pane-text churn flushes at most every REVIEW_PROGRESS_FLUSH_MS.
 */
export class ReviewProgress {
  private readonly rows: ReviewProgressRow[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private readonly onUpdate?: AgentToolUpdateCallback;

  constructor(onUpdate?: AgentToolUpdateCallback) {
    this.onUpdate = onUpdate;
  }

  add(agent: string, model: string, thinking: string): number {
    this.rows.push({ agent, model, thinking, status: "waiting", tail: [] });
    this.flush();
    return this.rows.length - 1;
  }

  /** Accepts the subagent tool's partial `details` ({ status, text, attachCommand }). */
  childUpdate(index: number, details: unknown): void {
    const row = this.rows[index];
    if (!(row && record(details))) {
      return;
    }
    const status = details.status;
    if (status !== "queued" && status !== "running") {
      return;
    }
    const tail =
      typeof details.text === "string" ? tailLines(details.text) : [];
    const attachCommand =
      typeof details.attachCommand === "string"
        ? details.attachCommand
        : undefined;
    const statusChanged = row.status !== status;
    if (
      !statusChanged &&
      row.attachCommand === attachCommand &&
      row.tail.join("\n") === tail.join("\n")
    ) {
      return;
    }
    row.status = status;
    if (status === "running") {
      row.startedAt ??= Date.now();
      row.tail = tail;
      row.attachCommand = attachCommand;
    }
    if (statusChanged) {
      this.flush();
    } else {
      this.schedule();
    }
  }

  settle(index: number, failed: boolean): void {
    const row = this.rows[index];
    if (!row) {
      return;
    }
    row.status = failed ? "failed" : "done";
    row.durationMs =
      row.startedAt === undefined ? undefined : Date.now() - row.startedAt;
    row.tail = [];
    row.attachCommand = undefined;
    this.flush();
  }

  dispose(): void {
    if (this.timer) {
      this.flush();
    }
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, REVIEW_PROGRESS_FLUSH_MS);
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.onUpdate) {
      return;
    }
    const details: ReviewProgressDetails = {
      reviewProgress: this.rows.map((row) => ({ ...row, tail: [...row.tail] })),
    };
    this.onUpdate({
      content: [{ type: "text", text: activeText(this.rows) }],
      details,
    });
  }
}
