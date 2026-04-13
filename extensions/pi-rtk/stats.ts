import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

import type {
  PiRtkCommandMetrics,
  PiRtkConfig,
  PiRtkMetricsSnapshot,
  PiRtkStatsRow,
} from "./types";

const BAR_WIDTH = 20;
const SUMMARY_LABEL_WIDTH = 18;
const TEXT_FALLBACK_WIDTH = 72;
const TABLE_MIN_WIDTH = 76;
const MAX_TOOL_ROWS = 4;
const MAX_FAMILY_ROWS = 8;
const MAX_COMMAND_ROWS = 10;
const IMPACT_BAR_MIN_WIDTH = 12;
const IMPACT_BAR_MAX_WIDTH = 18;
const OVERLAY_HEIGHT_RATIO = 0.9;
const MIN_BODY_HEIGHT = 12;
const CHROME_ROWS = 8;
const HELP =
  "↑↓/j/k scroll · pgup/pgdn or ctrl+b/ctrl+f faster · home/end · esc/q/enter close";

type ThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type FramePalette = {
  border(text: string): string;
  title(text: string): string;
};

const FRAME_BORDER_COLOR = "2";
const FRAME_TITLE_COLOR = "2";

function applyAnsiColor(code: string, text: string): string {
  if (!code) {
    return text;
  }

  return `\x1b[${code}m${text}\x1b[0m`;
}

function formatTokens(count: number | null): string {
  if (count === null) {
    return "unknown";
  }

  if (count < 1000) {
    return `${count}`;
  }

  if (count < 10000) {
    return `${(count / 1000).toFixed(1)}k`;
  }

  if (count < 1_000_000) {
    return `${Math.round(count / 1000)}k`;
  }

  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1_000);
    return `${minutes}m${seconds}s`;
  }

  if (ms >= 1_000) {
    const seconds = ms / 1_000;
    return seconds >= 10
      ? `${seconds.toFixed(1).replace(/\.0$/, "")}s`
      : `${seconds.toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}s`;
  }

  return `${Math.round(ms)}ms`;
}

function repeat(char: string, count: number): string {
  return char.repeat(Math.max(0, count));
}

function getBarFillWidth(percent: number, width: number): number {
  const clamped = Math.max(0, Math.min(100, percent));
  return Math.round((clamped / 100) * width);
}

export function renderProgressBar(percent: number, width = BAR_WIDTH): string {
  const filled = getBarFillWidth(percent, width);
  return `${repeat("█", filled)}${repeat("░", width - filled)}`;
}

function applyThemeColor(
  theme: ThemeLike | undefined,
  color: string,
  text: string
): string {
  if (!theme || !text) {
    return text;
  }

  return theme.fg(color, text);
}

function getSavingsPercentTone(percent: number): string {
  if (percent >= 90) {
    return "success";
  }

  if (percent >= 75) {
    return "accent";
  }

  if (percent >= 50) {
    return "warning";
  }

  return "error";
}

function formatColoredPercent(
  percent: number,
  width: number,
  theme?: ThemeLike
): string {
  const value = formatPercent(percent).padStart(width);
  return applyThemeColor(theme, getSavingsPercentTone(percent), value);
}

function renderImpactBar(
  percent: number,
  width: number,
  theme?: ThemeLike
): string {
  const filled = getBarFillWidth(percent, width);
  return `${applyThemeColor(theme, "accent", repeat("█", filled))}${applyThemeColor(theme, "dim", repeat("░", width - filled))}`;
}

function padSummaryLabel(label: string): string {
  return label.padEnd(SUMMARY_LABEL_WIDTH, " ");
}

function truncatePlain(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  return truncateToWidth(text.replace(/\s+/g, " ").trim(), width);
}

function formatCommandLabel(
  command: PiRtkCommandMetrics,
  width: number
): string {
  const prefix = command.toolName === "user-bash" ? "! " : "";
  return truncatePlain(`${prefix}${command.label}`, width);
}

function formatStatsRowLabel(row: PiRtkStatsRow, width: number): string {
  return truncatePlain(row.label, width);
}

function buildStatusNotes(
  metrics: PiRtkMetricsSnapshot,
  config: PiRtkConfig
): string[] {
  const notes: string[] = [];

  if (!config.enabled) {
    notes.push("RTK is disabled. Session stats stay frozen until /rtk enable.");
  }

  if (!config.outputCompaction.enabled) {
    notes.push(
      "Output compaction is off. Token savings are only tracked while compaction is enabled."
    );
  } else if (!config.outputCompaction.trackSavings) {
    notes.push(
      "Savings tracking is off. Enable outputCompaction.trackSavings to collect estimates."
    );
  }

  if (!metrics.hasCommandData) {
    notes.push(
      "No session savings yet. Run bash/read/grep with RTK compaction enabled to populate this dashboard."
    );
  }

  return notes;
}

function buildSummaryLines(
  metrics: PiRtkMetricsSnapshot,
  config: PiRtkConfig
): string[] {
  const summary = metrics.summary;
  const statusNotes = buildStatusNotes(metrics, config);

  return [
    "RTK Token Savings (Session Scope)",
    "Estimated tokens · session-only",
    "",
    ...statusNotes,
    ...(statusNotes.length > 0 ? [""] : []),
    "Overview",
    "",
    `${padSummaryLabel("Total commands:")}${summary.totalCommands}`,
    `${padSummaryLabel("Input tokens:")}${formatTokens(summary.totalInputTokens)}`,
    `${padSummaryLabel("Output tokens:")}${formatTokens(summary.totalOutputTokens)}`,
    `${padSummaryLabel("Tokens saved:")}${formatTokens(summary.totalSavedTokens)} (${formatPercent(summary.avgSavingsPercent)})`,
    `${padSummaryLabel("Total exec time:")}${formatDuration(summary.totalExecMs)} (avg ${formatDuration(summary.avgExecMs)})`,
    `${padSummaryLabel("Efficiency meter:")}${renderProgressBar(summary.avgSavingsPercent)} ${formatPercent(summary.avgSavingsPercent)}`,
    `${padSummaryLabel("Rewrite rate:")}${metrics.rewritesApplied}/${metrics.rewriteAttempts} (${metrics.rewriteRatePercent}%) · fallbacks ${metrics.rewriteFallbacks}`,
    `${padSummaryLabel("User !cmd:")}${metrics.userBashRewrites}/${metrics.userBashAttempts} rewrites (${metrics.userBashRewriteRatePercent}%)`,
  ];
}

function buildRankedTableLines<T extends PiRtkStatsRow>(options: {
  title: string;
  labelHeader: string;
  rows: T[];
  width: number;
  theme?: ThemeLike;
  maxRows: number;
  emptyMessage: string;
  hiddenLabel: string;
  formatLabel: (row: T, width: number) => string;
}): string[] {
  const {
    title,
    labelHeader,
    rows,
    width,
    theme,
    maxRows,
    emptyMessage,
    hiddenLabel,
    formatLabel,
  } = options;
  const visibleRows = rows.slice(0, maxRows);
  const rankWidth = visibleRows.length >= 10 ? 4 : 3;
  const countWidth = 5;
  const savedWidth = 8;
  const avgWidth = 7;
  const timeWidth = 9;
  const impactWidth = Math.max(
    IMPACT_BAR_MIN_WIDTH,
    Math.min(IMPACT_BAR_MAX_WIDTH, Math.floor(width * 0.17))
  );
  const labelWidth = Math.max(
    16,
    width -
      (rankWidth +
        countWidth +
        savedWidth +
        avgWidth +
        timeWidth +
        impactWidth +
        6)
  );
  const totalSavedTokens = rows.reduce((sum, row) => sum + row.savedTokens, 0);

  const header = [
    title,
    "",
    `${"#".padEnd(rankWidth)} ${labelHeader.padEnd(labelWidth)} ${"Count".padStart(countWidth)} ${"Saved".padStart(savedWidth)} ${"Avg%".padStart(avgWidth)} ${"Time".padStart(timeWidth)} ${"Impact".padEnd(impactWidth)}`,
    `${repeat("-", rankWidth)} ${repeat("-", labelWidth)} ${repeat("-", countWidth)} ${repeat("-", savedWidth)} ${repeat("-", avgWidth)} ${repeat("-", timeWidth)} ${repeat("-", impactWidth)}`,
  ];

  if (visibleRows.length === 0) {
    return [...header, emptyMessage];
  }

  const lines = visibleRows.map((row, index) => {
    const rank = `${index + 1}.`.padEnd(rankWidth);
    const formattedLabel = applyThemeColor(
      theme,
      "accent",
      formatLabel(row, labelWidth).padEnd(labelWidth)
    );
    const impactShare =
      totalSavedTokens > 0 ? (row.savedTokens / totalSavedTokens) * 100 : 0;

    return `${rank} ${formattedLabel} ${String(row.count).padStart(countWidth)} ${formatTokens(row.savedTokens).padStart(savedWidth)} ${formatColoredPercent(row.savingsPercent, avgWidth, theme)} ${formatDuration(row.avgExecMs).padStart(timeWidth)} ${renderImpactBar(impactShare, impactWidth, theme)}`;
  });

  if (rows.length > visibleRows.length) {
    lines.push(
      `+ ${rows.length - visibleRows.length} more ${hiddenLabel} row(s)`
    );
  }

  return [...header, ...lines];
}

function buildToolLines(
  metrics: PiRtkMetricsSnapshot,
  width: number,
  theme?: ThemeLike
): string[] {
  return buildRankedTableLines({
    title: "By Tool",
    labelHeader: "Tool",
    rows: metrics.tools,
    width,
    theme,
    maxRows: MAX_TOOL_ROWS,
    emptyMessage: "No tool rows yet.",
    hiddenLabel: "tool",
    formatLabel: formatStatsRowLabel,
  });
}

function buildCommandFamilyLines(
  metrics: PiRtkMetricsSnapshot,
  width: number,
  theme?: ThemeLike
): string[] {
  return buildRankedTableLines({
    title: "Top Command Families",
    labelHeader: "Family",
    rows: metrics.commandFamilies,
    width,
    theme,
    maxRows: MAX_FAMILY_ROWS,
    emptyMessage: "No command families yet.",
    hiddenLabel: "command family",
    formatLabel: formatStatsRowLabel,
  });
}

function buildRawCommandLines(
  metrics: PiRtkMetricsSnapshot,
  width: number,
  theme?: ThemeLike
): string[] {
  return buildRankedTableLines({
    title: "Raw Command Rows",
    labelHeader: "Command",
    rows: metrics.commands,
    width,
    theme,
    maxRows: MAX_COMMAND_ROWS,
    emptyMessage: "No raw command rows yet.",
    hiddenLabel: "raw command",
    formatLabel: formatCommandLabel,
  });
}

function buildBodyLines(
  metrics: PiRtkMetricsSnapshot,
  config: PiRtkConfig,
  width: number,
  theme?: ThemeLike
): string[] {
  const tableWidth = Math.max(TABLE_MIN_WIDTH, width);

  return [
    ...buildSummaryLines(metrics, config),
    "",
    ...buildToolLines(metrics, tableWidth, theme),
    "",
    ...buildCommandFamilyLines(metrics, tableWidth, theme),
    "",
    ...buildRawCommandLines(metrics, tableWidth, theme),
  ];
}

export function renderRtkStats(
  metrics: PiRtkMetricsSnapshot,
  config: PiRtkConfig,
  width = 120
): string {
  return buildBodyLines(
    metrics,
    config,
    Math.max(TEXT_FALLBACK_WIDTH, width)
  ).join("\n");
}

function fitRenderedLinesToWidth(lines: string[], width: number): string[] {
  return lines.flatMap((line) =>
    wrapTextWithAnsi(line, width).map((wrapped) =>
      truncateToWidth(wrapped, width)
    )
  );
}

const FRAME_PALETTE: FramePalette = {
  border(text: string): string {
    return applyAnsiColor(FRAME_BORDER_COLOR, text);
  },
  title(text: string): string {
    return applyAnsiColor(FRAME_TITLE_COLOR, text);
  },
};

function frameLine(
  content: string,
  width: number,
  framePalette: FramePalette
): string {
  const innerWidth = Math.max(0, width - 4);
  const clipped = truncateToWidth(content, innerWidth);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  return `${framePalette.border("│")} ${clipped}${padding} ${framePalette.border("│")}`;
}

function border(
  width: number,
  left: string,
  fill: string,
  right: string,
  framePalette: FramePalette
): string {
  return framePalette.border(
    `${left}${fill.repeat(Math.max(0, width - 2))}${right}`
  );
}

function titledTopBorder(
  width: number,
  titleText: string,
  framePalette: FramePalette
): string {
  const innerWidth = Math.max(0, width - 2);
  const borderLen = Math.max(0, innerWidth - visibleWidth(titleText));
  const leftBorder = Math.floor(borderLen / 2);
  const rightBorder = borderLen - leftBorder;

  return (
    framePalette.border(`╭${"─".repeat(leftBorder)}`) +
    framePalette.title(titleText) +
    framePalette.border(`${"─".repeat(rightBorder)}╮`)
  );
}

function buildStatusLine(
  scroll: number,
  visibleRows: number,
  totalRows: number
): string {
  if (totalRows <= 0) {
    return HELP;
  }

  const from = Math.min(totalRows, scroll + 1);
  const to = Math.min(totalRows, scroll + visibleRows);
  return `${HELP} · ${from}-${to}/${totalRows}`;
}

function decorateLines(lines: string[], theme: ThemeLike): string[] {
  const sectionTitles = new Set([
    "RTK Token Savings (Session Scope)",
    "Overview",
    "By Tool",
    "Top Command Families",
    "Raw Command Rows",
  ]);

  return lines.map((line) => {
    if (sectionTitles.has(line)) {
      return theme.bold(theme.fg("toolTitle", line));
    }

    if (line === "Estimated tokens · session-only") {
      return theme.fg("muted", line);
    }

    if (
      line.startsWith("RTK is disabled") ||
      line.startsWith("Output compaction is off") ||
      line.startsWith("Savings tracking is off")
    ) {
      return theme.fg("warning", line);
    }

    if (line.startsWith("No ")) {
      return theme.fg("dim", line);
    }

    if (line.startsWith("+ ")) {
      return theme.fg("muted", line);
    }

    return line;
  });
}

export async function showRtkStatsView(
  ctx: ExtensionCommandContext,
  metrics: PiRtkMetricsSnapshot,
  config: PiRtkConfig
): Promise<void> {
  if (!ctx.hasUI) {
    process.stdout.write(`${renderRtkStats(metrics, config)}\n`);
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      let scroll = 0;
      let cachedWidth = -1;
      let cachedBody: string[] = [];
      let lastInnerWidth = 80;

      const refresh = () => {
        cachedWidth = -1;
        tui.requestRender();
      };

      const getBodyHeight = () =>
        Math.max(
          MIN_BODY_HEIGHT,
          Math.floor(tui.terminal.rows * OVERLAY_HEIGHT_RATIO) - CHROME_ROWS
        );

      const getBodyLines = (width: number) => {
        if (cachedWidth === width) {
          return cachedBody;
        }

        cachedWidth = width;
        cachedBody = fitRenderedLinesToWidth(
          decorateLines(buildBodyLines(metrics, config, width, theme), theme),
          Math.max(8, width)
        );
        return cachedBody;
      };

      return {
        invalidate() {
          cachedWidth = -1;
        },
        render(width: number) {
          if (width < TEXT_FALLBACK_WIDTH) {
            return fitRenderedLinesToWidth(
              renderRtkStats(metrics, config, width).split("\n"),
              width
            );
          }

          const frameWidth = Math.max(28, width);
          const innerWidth = Math.max(8, frameWidth - 4);
          lastInnerWidth = innerWidth;
          const body = getBodyLines(innerWidth);
          const bodyHeight = getBodyHeight();
          const maxScroll = Math.max(0, body.length - bodyHeight);
          scroll = Math.min(scroll, maxScroll);
          const visibleBody = body.slice(scroll, scroll + bodyHeight);
          const lines = [
            titledTopBorder(frameWidth, " /rtk stats ", FRAME_PALETTE),
            frameLine(
              theme.fg("dim", "Session-only dashboard · estimated tokens"),
              frameWidth,
              FRAME_PALETTE
            ),
            border(frameWidth, "├", "─", "┤", FRAME_PALETTE),
            ...visibleBody.map((line) =>
              frameLine(line, frameWidth, FRAME_PALETTE)
            ),
          ];

          while (lines.length < bodyHeight + 3) {
            lines.push(frameLine("", frameWidth, FRAME_PALETTE));
          }

          lines.push(border(frameWidth, "├", "─", "┤", FRAME_PALETTE));
          lines.push(
            frameLine(
              theme.fg(
                "dim",
                buildStatusLine(scroll, visibleBody.length, body.length)
              ),
              frameWidth,
              FRAME_PALETTE
            )
          );
          lines.push(border(frameWidth, "╰", "─", "╯", FRAME_PALETTE));
          return lines;
        },
        handleInput(data: string) {
          const bodyHeight = getBodyHeight();
          const maxScroll = Math.max(
            0,
            getBodyLines(lastInnerWidth).length - bodyHeight
          );

          if (
            matchesKey(data, Key.escape) ||
            matchesKey(data, Key.enter) ||
            data.toLowerCase() === "q"
          ) {
            done(undefined);
            return;
          }

          if (matchesKey(data, Key.up) || data.toLowerCase() === "k") {
            scroll = Math.max(0, scroll - 1);
            refresh();
            return;
          }

          if (matchesKey(data, Key.down) || data.toLowerCase() === "j") {
            scroll = Math.min(maxScroll, scroll + 1);
            refresh();
            return;
          }

          if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) {
            scroll = Math.max(0, scroll - Math.max(1, bodyHeight - 2));
            refresh();
            return;
          }

          if (
            matchesKey(data, Key.pageDown) ||
            matchesKey(data, Key.ctrl("f"))
          ) {
            scroll = Math.min(maxScroll, scroll + Math.max(1, bodyHeight - 2));
            refresh();
            return;
          }

          if (matchesKey(data, Key.home)) {
            scroll = 0;
            refresh();
            return;
          }

          if (matchesKey(data, Key.end)) {
            scroll = maxScroll;
            refresh();
          }
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "94%",
        maxHeight: "92%",
        margin: 1,
      },
    }
  );
}
