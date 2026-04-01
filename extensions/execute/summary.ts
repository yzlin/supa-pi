import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import type {
  ExecuteErrorDetails,
  ExecuteRenderStyles,
  ExecuteStepResult,
  ExecuteStructuredResultSummary,
  ExecuteSummaryDetails,
} from "./types";
import { uniqueStrings, truncateInline } from "./utils";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";

export const buildSummaryMessage = (details: ExecuteSummaryDetails): string => {
  const lines = [
    "## /execute-wave summary",
    "",
    `- Initial plan items: ${details.planItems.length}`,
    `- Waves executed: ${details.waves.length}`,
    `- Completed items: ${details.completed.length}`,
    `- Blocked items: ${details.blocked.length}`,
    `- Files touched: ${details.filesTouched.length}`,
    `- Validation steps: ${details.validation.length}`,
  ];

  if (details.waves.length > 0) {
    lines.push("", "### Waves");
    for (const wave of details.waves) {
      lines.push(
        `- Wave ${wave.wave}: ${wave.jobId} — ${wave.totalItems} items, ${wave.completedItems} completed, ${wave.errorCount} errors, ${wave.queuedFollowUps} follow-ups`
      );
    }
  }

  if (details.completed.length > 0) {
    lines.push("", "### Completed items");
    for (const item of details.completed) {
      lines.push(`- ${item.item} — ${item.summary}`);
    }
  }

  if (details.blocked.length > 0) {
    lines.push("", "### Blocked items");
    for (const item of details.blocked) {
      lines.push(`- ${item.item} — ${item.reason}`);
    }
  }

  if (details.filesTouched.length > 0) {
    lines.push("", "### Files touched");
    for (const file of details.filesTouched) {
      lines.push(`- ${file}`);
    }
  }

  if (details.validation.length > 0) {
    lines.push("", "### Validation");
    for (const check of details.validation) {
      lines.push(`- ${check}`);
    }
  }

  if (details.remainingFollowUps.length > 0) {
    lines.push("", "### Remaining follow-ups");
    for (const followUp of details.remainingFollowUps) {
      lines.push(`- ${followUp}`);
    }
  }

  return lines.join("\n");
};

export const isExecuteErrorDetails = (
  value: unknown
): value is ExecuteErrorDetails => isRecord(value) && typeof value.error === "string";

export const isExecuteSummaryDetails = (
  value: unknown
): value is ExecuteSummaryDetails =>
  isRecord(value) &&
  Array.isArray(value.planItems) &&
  Array.isArray(value.waves) &&
  Array.isArray(value.completed) &&
  Array.isArray(value.blocked) &&
  Array.isArray(value.filesTouched) &&
  Array.isArray(value.validation) &&
  Array.isArray(value.remainingFollowUps);

export const sendExecuteSummaryMessage = (
  pi: ExtensionAPI,
  content: string,
  details: unknown
): void => {
  pi.sendMessage(
    {
      customType: "execute-summary",
      content,
      display: true,
      details,
    },
    { triggerTurn: false }
  );
};

const defaultRenderStyles: ExecuteRenderStyles = {
  accent: (text) => text,
  dim: (text) => text,
  success: (text) => text,
  warning: (text) => text,
  error: (text) => text,
};

export const buildExecuteSummaryRenderText = (
  details: ExecuteSummaryDetails | ExecuteErrorDetails,
  expanded: boolean,
  styles: ExecuteRenderStyles = defaultRenderStyles,
  compactWidth = 140
): string => {
  if (isExecuteErrorDetails(details)) {
    return [
      styles.error("/execute-wave failed"),
      `${styles.error("!")} ${details.error}`,
    ].join("\n");
  }

  const lines = [
    styles.accent("/execute-wave"),
    `Plan ${details.planItems.length}  Waves ${details.waves.length}  ${styles.success(`Done ${details.completed.length}`)}  ${styles.warning(`Blocked ${details.blocked.length}`)}`,
    styles.dim(
      `Files ${details.filesTouched.length}  Validation ${details.validation.length}`
    ),
  ];
  const compactLineWidth = Math.max(72, compactWidth);

  const visibleWaves = expanded ? details.waves : details.waves.slice(0, 3);
  if (visibleWaves.length > 0) {
    lines.push("", styles.accent("Waves"));
    for (const wave of visibleWaves) {
      const statusLabel =
        wave.errorCount > 0
          ? styles.warning(`${wave.errorCount} errors`)
          : styles.success("ok");
      const jobLabel = expanded ? `  ${styles.dim(wave.jobId)}` : "";
      lines.push(
        `${styles.dim("•")} Wave ${wave.wave}${jobLabel}  ${wave.completedItems}/${wave.totalItems} done  ${statusLabel}  ${styles.dim(`${wave.queuedFollowUps} follow-ups`)}`
      );
    }
    if (!expanded && details.waves.length > visibleWaves.length) {
      lines.push(
        styles.dim(
          `… ${details.waves.length - visibleWaves.length} more wave(s)`
        )
      );
    }
  }

  const visibleCompleted = expanded
    ? details.completed
    : details.completed.slice(0, 3);
  if (visibleCompleted.length > 0) {
    lines.push("", styles.accent("Completed"));
    for (const item of visibleCompleted) {
      if (expanded) {
        lines.push(`${styles.success("✓")} ${item.item}`);
        lines.push(`  ${item.summary}`);
      } else {
        lines.push(
          `${styles.success("✓")} ${truncateInline(`${item.item} — ${item.summary}`, compactLineWidth)}`
        );
      }
    }
    if (!expanded && details.completed.length > visibleCompleted.length) {
      lines.push(
        styles.dim(
          `… ${details.completed.length - visibleCompleted.length} more completed item(s)`
        )
      );
    }
  }

  const visibleBlocked = expanded
    ? details.blocked
    : details.blocked.slice(0, 3);
  if (visibleBlocked.length > 0) {
    lines.push("", styles.accent("Blocked"));
    for (const item of visibleBlocked) {
      if (expanded) {
        lines.push(`${styles.warning("!")} ${item.item}`);
        lines.push(`  ${item.reason}`);
      } else {
        lines.push(
          `${styles.warning("!")} ${truncateInline(`${item.item} — ${item.reason}`, compactLineWidth)}`
        );
      }
    }
    if (!expanded && details.blocked.length > visibleBlocked.length) {
      lines.push(
        styles.dim(
          `… ${details.blocked.length - visibleBlocked.length} more blocked item(s)`
        )
      );
    }
  }

  if (expanded && details.filesTouched.length > 0) {
    lines.push("", styles.accent("Files touched"));
    for (const file of details.filesTouched) {
      lines.push(`${styles.dim("•")} ${file}`);
    }
  }

  if (details.validation.length > 0) {
    lines.push("", styles.accent("Validation"));
    for (const check of expanded
      ? details.validation
      : details.validation.slice(0, 5)) {
      lines.push(
        `${styles.dim("•")} ${truncateInline(check, expanded ? 400 : compactLineWidth)}`
      );
    }
    if (!expanded && details.validation.length > 5) {
      lines.push(
        styles.dim(`… ${details.validation.length - 5} more validation step(s)`)
      );
    }
  }

  if (details.remainingFollowUps.length > 0) {
    lines.push("", styles.accent("Remaining follow-ups"));
    for (const followUp of expanded
      ? details.remainingFollowUps
      : details.remainingFollowUps.slice(0, 5)) {
      lines.push(
        `${styles.dim("→")} ${truncateInline(followUp, expanded ? 400 : compactLineWidth)}`
      );
    }
    if (!expanded && details.remainingFollowUps.length > 5) {
      lines.push(
        styles.dim(
          `… ${details.remainingFollowUps.length - 5} more follow-up(s)`
        )
      );
    }
  }

  if (!expanded) {
    const hasHiddenDetails =
      details.waves.length > visibleWaves.length ||
      details.completed.length > visibleCompleted.length ||
      details.blocked.length > visibleBlocked.length ||
      details.filesTouched.length > 0 ||
      details.remainingFollowUps.length > 0 ||
      details.validation.length > 5;
    if (hasHiddenDetails) {
      lines.push(
        "",
        styles.dim(
          "↵ expand for job ids, full summaries, files, and follow-ups"
        )
      );
    }
  }

  return lines.join("\n");
};

const buildBlockedReason = (result: ExecuteStepResult): string => {
  const blockers = uniqueStrings(
    result.blockers.map((entry) => entry.trim()).filter(Boolean)
  );
  return blockers.length > 0 ? blockers.join("; ") : result.summary;
};

export const summarizeExecuteStructuredResult = (
  item: string,
  result: ExecuteStepResult
): ExecuteStructuredResultSummary => {
  const filesTouched = result.filesTouched
    .map((entry) => entry.trim())
    .filter(Boolean);
  const validation = result.validation
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (result.status === "blocked") {
    return {
      completed: null,
      blocked: {
        item,
        reason: buildBlockedReason(result),
      },
      filesTouched,
      validation,
      followUps: [],
    };
  }

  return {
    completed: {
      item,
      status: result.status,
      summary: result.summary,
    },
    blocked: null,
    filesTouched,
    validation,
    followUps: result.followUps.map((entry) => entry.trim()).filter(Boolean),
  };
};

export class ExecuteSummaryBody {
  private readonly text = new Text();

  constructor(
    private readonly details: ExecuteSummaryDetails | ExecuteErrorDetails,
    private readonly expanded: boolean,
    private readonly styles: ExecuteRenderStyles
  ) {}

  render(width: number): string[] {
    this.text.setText(
      buildExecuteSummaryRenderText(
        this.details,
        this.expanded,
        this.styles,
        Math.max(72, width - 4)
      )
    );
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}
