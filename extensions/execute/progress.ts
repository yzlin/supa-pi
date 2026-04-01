import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";

import type { MapTaskProgressEvent } from "../../../pi-lcm/src/map-runner.ts";

import {
  EXECUTE_PROGRESS_DETAIL_FULL_LENGTH,
  EXECUTE_PROGRESS_DETAIL_PREVIEW_LENGTH,
  EXECUTE_PROGRESS_WIDGET_HISTORY_LIMIT,
} from "./constants";
import type {
  ExecuteProgressHistoryEntry,
  ExecuteProgressRenderStyles,
  ExecuteProgressTone,
  ExecuteProgressWidgetEntry,
  ExecuteProgressWidgetState,
  ExecuteWidgetWaveState,
} from "./types";
import { flattenInline, truncateInline } from "./utils";

const collectExecuteProgressText = (value: unknown): string[] => {
  if (value == null) {
    return [];
  }

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectExecuteProgressText(entry));
  }

  if (typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;

  if (Array.isArray(record.content)) {
    return collectExecuteProgressText(record.content);
  }

  if (typeof record.text === "string") {
    return [record.text];
  }

  if (typeof record.error === "string") {
    return [record.error];
  }

  if (typeof record.message === "string") {
    return [record.message];
  }

  if (typeof record.stderr === "string") {
    return [record.stderr];
  }

  return [];
};

const decodeExecuteJsonishString = (value: string): string =>
  value
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");

const collectExecuteJsonishFields = (value: string): string[] => {
  const matches: string[] = [];
  const fieldPattern =
    /"(text|error|message|stderr)"\s*:\s*"((?:\\.|[^"\\])*)/g;

  for (const match of value.matchAll(fieldPattern)) {
    const fragment = match[2];
    if (!fragment) continue;
    const decoded = decodeExecuteJsonishString(fragment)
      .replace(/\s+/g, " ")
      .trim();
    if (decoded) {
      matches.push(decoded);
    }
  }

  return matches;
};

const formatInlineLabel = (value: string, maxLength?: number): string => {
  const flattened = flattenInline(value);
  if (!flattened) {
    return "";
  }

  return typeof maxLength === "number"
    ? truncateInline(flattened, maxLength)
    : flattened;
};

const formatExecuteToolDetail = (
  toolName: string | undefined,
  detail: string,
  maxLength: number
): string => {
  const flattened = flattenInline(detail);
  if (!flattened) {
    return "";
  }

  const effectiveMaxLength =
    toolName === "edit" || toolName === "write"
      ? Math.min(maxLength, 56)
      : maxLength;
  return truncateInline(flattened, effectiveMaxLength);
};

const formatExecuteProgressDetail = (
  toolName: string | undefined,
  value: string | undefined,
  maxLength = 72
): string => {
  if (!value) {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const looksStructured = trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsed: unknown = trimmed;
  let parsedStructuredValue = false;
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      parsed = JSON.parse(trimmed);
      parsedStructuredValue = true;
    } catch {
      parsed = trimmed;
    }
  }

  const structuredText = parsedStructuredValue
    ? collectExecuteProgressText(parsed)
    : [];
  const extracted = structuredText
    .concat(collectExecuteJsonishFields(trimmed))
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (extracted.length > 0) {
    return formatExecuteToolDetail(toolName, extracted[0] ?? "", maxLength);
  }

  if (
    parsedStructuredValue ||
    looksStructured ||
    /"content"\s*:\s*\[\s*\]/.test(trimmed)
  ) {
    return "";
  }

  return formatExecuteToolDetail(toolName, trimmed, maxLength);
};

export const buildExecuteLiveStatus = (
  wave: number,
  item: string,
  event: MapTaskProgressEvent,
  options: { itemMaxLength?: number; detailMaxLength?: number } = {}
): string => {
  const itemLabel = formatInlineLabel(item, options.itemMaxLength);
  const detailMaxLength = options.detailMaxLength ?? 72;

  switch (event.type) {
    case "assistant_text":
      return `Wave ${wave}: ${itemLabel} — thinking…`;
    case "tool_start":
      return `Wave ${wave}: ${itemLabel} — ${event.toolName}…`;
    case "tool_update": {
      const detail = formatExecuteProgressDetail(
        event.toolName,
        event.text,
        detailMaxLength
      );
      return `Wave ${wave}: ${itemLabel} — ${event.toolName}${detail ? `: ${detail}` : ""}`;
    }
    case "tool_end": {
      const outcome = event.isError ? "error" : "done";
      const detail = formatExecuteProgressDetail(
        event.toolName,
        event.text,
        detailMaxLength
      );
      return `Wave ${wave}: ${itemLabel} — ${event.toolName} ${outcome}${detail ? `: ${detail}` : ""}`;
    }
  }
};

export const buildExecuteLiveProgressEntry = (
  wave: number,
  item: string,
  event: MapTaskProgressEvent,
  options: { itemMaxLength?: number; detailMaxLength?: number } = {}
): ExecuteProgressWidgetEntry => {
  const headline = `Wave ${wave}: ${formatInlineLabel(item, options.itemMaxLength)}`;
  const detailMaxLength =
    options.detailMaxLength ?? EXECUTE_PROGRESS_DETAIL_FULL_LENGTH;

  switch (event.type) {
    case "assistant_text": {
      const detail =
        formatExecuteProgressDetail(undefined, event.text, detailMaxLength) ||
        "Thinking…";
      return {
        headline,
        blockLabel: "thinking",
        metadata: [],
        detail,
        tone: "accent",
      };
    }
    case "tool_start":
      return {
        headline,
        blockLabel: "tool call",
        metadata: [event.toolName],
        detail: null,
        tone: "accent",
      };
    case "tool_update": {
      const detail =
        formatExecuteProgressDetail(
          event.toolName,
          event.text,
          detailMaxLength
        ) || null;
      return {
        headline,
        blockLabel: "tool update",
        metadata: [event.toolName],
        detail,
        tone: "accent",
      };
    }
    case "tool_end": {
      const detail =
        formatExecuteProgressDetail(
          event.toolName,
          event.text,
          detailMaxLength
        ) ||
        (event.isError ? "Tool failed without additional detail" : "Completed");
      return {
        headline,
        blockLabel: event.isError ? "tool error" : "tool result",
        metadata: [event.toolName, event.isError ? "error" : "ok"],
        detail,
        tone: event.isError ? "warning" : "success",
      };
    }
  }
};

const buildExecuteWidgetPreview = (planItems: string[]): string => {
  if (planItems.length === 0) {
    return "waiting for plan items";
  }

  const firstItem = formatInlineLabel(planItems[0] ?? "");
  if (planItems.length === 1) {
    return firstItem;
  }

  return `${planItems.length} items — ${firstItem}`;
};

const defaultExecuteProgressRenderStyles: ExecuteProgressRenderStyles = {
  accent: (text) => text,
  dim: (text) => text,
  success: (text) => text,
  warning: (text) => text,
};

const buildExecuteProgressBar = (
  completedItems: number,
  totalItems: number,
  width = 10
): string => {
  if (totalItems <= 0) {
    return `[${"░".repeat(width)}]`;
  }

  const ratio = Math.max(0, Math.min(1, completedItems / totalItems));
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `[${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}]`;
};

const getExecuteWaveStatus = (
  wave: Pick<ExecuteWidgetWaveState, "errorCount">,
  styles: ExecuteProgressRenderStyles,
  active: boolean
): string => {
  if (active) {
    return styles.accent("running");
  }

  if (wave.errorCount > 0) {
    return styles.warning(`${wave.errorCount} errors`);
  }

  return styles.success("ok");
};

const formatExecuteWidgetWaveLine = (
  wave: Pick<
    ExecuteWidgetWaveState,
    "wave" | "totalItems" | "completedItems" | "errorCount" | "queuedFollowUps"
  >,
  styles: ExecuteProgressRenderStyles,
  active = false
): string => {
  const status = getExecuteWaveStatus(wave, styles, active);
  const followUps =
    wave.queuedFollowUps > 0
      ? `${wave.queuedFollowUps} follow-ups`
      : "no follow-ups";
  return `${styles.dim("•")} Wave ${wave.wave}  ${buildExecuteProgressBar(wave.completedItems, wave.totalItems)}  ${wave.completedItems}/${wave.totalItems} done  ${status}  ${styles.dim(followUps)}`;
};

const splitExecuteCurrentStatus = (
  currentStatus: string
): { headline: string; detail: string | null } => {
  const trimmed = currentStatus.trim();
  const separatorIndex = trimmed.lastIndexOf(" — ");
  if (separatorIndex === -1) {
    return { headline: trimmed, detail: null };
  }

  return {
    headline: trimmed.slice(0, separatorIndex).trim(),
    detail: trimmed.slice(separatorIndex + 3).trim() || null,
  };
};

const formatExecuteProgressTone = (
  tone: ExecuteProgressTone,
  text: string,
  styles: ExecuteProgressRenderStyles
): string => {
  switch (tone) {
    case "success":
      return styles.success(text);
    case "warning":
      return styles.warning(text);
    case "dim":
      return styles.dim(text);
    case "accent":
    default:
      return styles.accent(text);
  }
};

export const isExecuteCurrentStatusExpandable = (
  currentStatus: string,
  currentEntry?: ExecuteProgressWidgetEntry
): boolean => {
  if (currentEntry) {
    return Boolean(
      currentEntry.detail &&
        currentEntry.detail.length > EXECUTE_PROGRESS_DETAIL_PREVIEW_LENGTH
    );
  }

  const { detail } = splitExecuteCurrentStatus(currentStatus);
  return Boolean(
    detail && detail.length > EXECUTE_PROGRESS_DETAIL_PREVIEW_LENGTH
  );
};

const getExecuteProgressDetailText = (
  detail: string | null | undefined,
  expanded: boolean
): string | null => {
  if (!detail) {
    return null;
  }

  if (detail.length > EXECUTE_PROGRESS_DETAIL_PREVIEW_LENGTH && !expanded) {
    return truncateInline(detail, EXECUTE_PROGRESS_DETAIL_PREVIEW_LENGTH);
  }

  return detail;
};

const appendExecuteProgressEntryLines = (
  lines: string[],
  entry: ExecuteProgressWidgetEntry,
  styles: ExecuteProgressRenderStyles,
  expanded = false
): void => {
  const detailText = getExecuteProgressDetailText(entry.detail, expanded);
  const metadata =
    entry.metadata.length > 0
      ? ` ${styles.dim(entry.metadata.join(" · "))}`
      : "";

  lines.push(`${styles.dim("•")} ${entry.headline}`);
  lines.push(
    `  ${formatExecuteProgressTone(entry.tone, `[${entry.blockLabel}]`, styles)}${metadata}`
  );
  if (detailText) {
    lines.push(`  ${styles.dim("↳")} ${detailText}`);
  }
};

const appendExecuteCurrentStatusLines = (
  lines: string[],
  currentStatus: string,
  expanded: boolean,
  styles: ExecuteProgressRenderStyles,
  currentEntry?: ExecuteProgressWidgetEntry
): void => {
  const current = currentStatus.trim();
  if (!current) {
    return;
  }

  lines.push("", styles.accent("Current"));

  if (currentEntry) {
    appendExecuteProgressEntryLines(lines, currentEntry, styles, expanded);
  } else {
    const { headline, detail } = splitExecuteCurrentStatus(current);
    const detailText = getExecuteProgressDetailText(detail, expanded);

    lines.push(`${styles.dim("•")} ${headline}`);

    if (detailText) {
      lines.push(`  ${styles.dim("↳")} ${detailText}`);
    }
  }

  if (isExecuteCurrentStatusExpandable(current, currentEntry)) {
    lines.push(
      styles.dim(
        expanded
          ? "ctrl+o collapse current detail"
          : "ctrl+o expand current detail"
      )
    );
  }
};

const formatExecuteRecentHistoryStatus = (
  entry: ExecuteProgressHistoryEntry,
  previousHeadline?: string
): string => {
  const headline = entry.entry?.headline?.trim();
  if (!headline || previousHeadline !== headline) {
    return entry.status;
  }

  const prefix = `${headline} — `;
  return entry.status.startsWith(prefix)
    ? entry.status.slice(prefix.length).trim()
    : entry.status;
};

const formatExecuteRecentHistoryLine = (
  entry: ExecuteProgressHistoryEntry,
  styles: ExecuteProgressRenderStyles,
  renderWidth?: number,
  previousHeadline?: string
): string => {
  const status = formatExecuteRecentHistoryStatus(entry, previousHeadline);
  const line = `${styles.dim("•")} ${status}`;

  if (typeof renderWidth !== "number" || !Number.isFinite(renderWidth)) {
    return line;
  }

  return truncateToWidth(line, renderWidth, "…");
};

const normalizeExecuteProgressHistoryEntry = (
  entry: string | ExecuteProgressHistoryEntry
): ExecuteProgressHistoryEntry | null => {
  if (typeof entry === "string") {
    const status = entry.trim();
    return status ? { status } : null;
  }

  const status = entry.status.trim();
  if (!status) {
    return null;
  }

  return {
    status,
    entry: entry.entry,
  };
};

export const buildExecuteProgressWidgetRenderText = (
  planItems: string[],
  currentStatus: string,
  history: Array<string | ExecuteProgressHistoryEntry>,
  progress?: ExecuteProgressWidgetState,
  styles: ExecuteProgressRenderStyles = defaultExecuteProgressRenderStyles,
  expandedCurrentStatus = false,
  currentEntry?: ExecuteProgressWidgetEntry,
  renderWidth?: number
): string => {
  const lines = [
    styles.accent("/execute-wave"),
    styles.dim(buildExecuteWidgetPreview(planItems)),
  ];

  if (progress) {
    const totalItems =
      progress.completedItems + progress.blockedItems + progress.remainingItems;
    const terminalItems = progress.completedItems + progress.blockedItems;
    lines.push(
      "",
      `${styles.accent("Overall")} ${buildExecuteProgressBar(terminalItems, totalItems)}  ${progress.completedItems} done  ${progress.blockedItems} blocked  ${progress.remainingItems} remaining`
    );

    const visibleWaves = [...progress.waves];
    if (progress.activeWave) {
      visibleWaves.push({
        wave: progress.activeWave.wave,
        totalItems: progress.activeWave.totalItems,
        completedItems: progress.activeWave.completedItems,
        errorCount: progress.activeWave.errorCount,
        queuedFollowUps: progress.activeWave.queuedFollowUps,
        jobId: "active",
      });
    }

    if (visibleWaves.length > 0) {
      lines.push("", styles.accent("Waves"));
      for (const wave of visibleWaves) {
        const isActiveWave = progress.activeWave?.wave === wave.wave;
        lines.push(formatExecuteWidgetWaveLine(wave, styles, isActiveWave));
        if (isActiveWave && progress.activeWave?.activeItem) {
          lines.push(
            `  ${styles.dim("active:")} ${formatInlineLabel(progress.activeWave.activeItem)}`
          );
        }
      }
    }
  }

  const current = currentStatus.trim();
  appendExecuteCurrentStatusLines(
    lines,
    currentStatus,
    expandedCurrentStatus,
    styles,
    currentEntry
  );

  const normalizedHistory = history
    .map(normalizeExecuteProgressHistoryEntry)
    .filter((entry): entry is ExecuteProgressHistoryEntry => entry !== null);
  const historyWithoutCurrent =
    current && normalizedHistory.at(-1)?.status === current
      ? normalizedHistory.slice(0, -1)
      : normalizedHistory;
  const visibleHistory = historyWithoutCurrent.slice(
    -EXECUTE_PROGRESS_WIDGET_HISTORY_LIMIT
  );
  const skipped = historyWithoutCurrent.length - visibleHistory.length;

  if (visibleHistory.length > 0) {
    lines.push("", styles.accent("Recent"));
    if (skipped > 0) {
      lines.push(styles.dim(`… ${skipped} earlier updates`));
    }
    let previousRecentHeadline: string | undefined;
    for (const entry of visibleHistory) {
      lines.push(
        formatExecuteRecentHistoryLine(
          entry,
          styles,
          renderWidth,
          previousRecentHeadline
        )
      );
      previousRecentHeadline = entry.entry?.headline?.trim() || undefined;
    }
  }

  return lines.join("\n");
};

export const buildExecuteProgressWidgetLines = (
  planItems: string[],
  currentStatus: string,
  history: Array<string | ExecuteProgressHistoryEntry>,
  progress?: ExecuteProgressWidgetState,
  expandedCurrentStatus = false,
  currentEntry?: ExecuteProgressWidgetEntry,
  renderWidth?: number
): string[] =>
  buildExecuteProgressWidgetRenderText(
    planItems,
    currentStatus,
    history,
    progress,
    undefined,
    expandedCurrentStatus,
    currentEntry,
    renderWidth
  ).split("\n");

class ExecuteProgressWidgetBody {
  private readonly text = new Text();

  constructor(
    private readonly planItems: string[],
    private readonly currentStatus: string,
    private readonly history: ExecuteProgressHistoryEntry[],
    private readonly progress: ExecuteProgressWidgetState | undefined,
    private readonly styles: ExecuteProgressRenderStyles,
    private readonly expandedCurrentStatus: boolean,
    private readonly currentEntry?: ExecuteProgressWidgetEntry
  ) {}

  render(width: number): string[] {
    this.text.setText(
      buildExecuteProgressWidgetRenderText(
        this.planItems,
        this.currentStatus,
        this.history,
        this.progress,
        this.styles,
        this.expandedCurrentStatus,
        this.currentEntry,
        width
      )
    );
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

export const updateExecuteProgressWidget = (
  ctx: ExtensionCommandContext,
  widgetKey: string,
  planItems: string[],
  currentStatus: string,
  history: ExecuteProgressHistoryEntry[],
  progress?: ExecuteProgressWidgetState,
  expandedCurrentStatus = false,
  currentEntry?: ExecuteProgressWidgetEntry
): void => {
  ctx.ui.setWidget(
    widgetKey,
    (_tui, theme) =>
      new ExecuteProgressWidgetBody(
        planItems,
        currentStatus,
        history,
        progress,
        {
          accent: (text: string) => theme.fg("accent", text),
          dim: (text: string) => theme.fg("dim", text),
          success: (text: string) => theme.fg("success", text),
          warning: (text: string) => theme.fg("warning", text),
        },
        expandedCurrentStatus,
        currentEntry
      ),
    {
      placement: "aboveEditor",
    }
  );
};
