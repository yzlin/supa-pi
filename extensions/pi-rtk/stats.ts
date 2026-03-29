import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

import { formatTokens } from "../context/render-text";
import type {
  PiRtkCommandMetrics,
  PiRtkConfig,
  PiRtkMetricsSnapshot,
} from "./types";

const BAR_WIDTH = 20;
const SUMMARY_LABEL_WIDTH = 18;
const TEXT_FALLBACK_WIDTH = 72;
const TABLE_MIN_WIDTH = 76;
const SIDE_BY_SIDE_WIDTH = 112;
const MAX_TABLE_ROWS = 10;
const OVERLAY_HEIGHT_RATIO = 0.9;
const MIN_BODY_HEIGHT = 12;
const CHROME_ROWS = 8;
const HELP =
  "↑↓/j/k scroll · pgup/pgdn or ctrl+b/ctrl+f faster · home/end · esc/q/enter close";

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

export function renderProgressBar(percent: number, width = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `${repeat("█", filled)}${repeat("░", width - filled)}`;
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
  const lines = [
    "RTK Token Savings (Session Scope)",
    "Estimated tokens · session-only · screenshot-inspired",
    "",
  ];

  lines.push(...buildStatusNotes(metrics, config));
  if (lines[lines.length - 1] !== "") {
    lines.push("");
  }

  lines.push(`${padSummaryLabel("Total commands:")}${summary.totalCommands}`);
  lines.push(
    `${padSummaryLabel("Input tokens:")}${formatTokens(summary.totalInputTokens)}`
  );
  lines.push(
    `${padSummaryLabel("Output tokens:")}${formatTokens(summary.totalOutputTokens)}`
  );
  lines.push(
    `${padSummaryLabel("Tokens saved:")}${formatTokens(summary.totalSavedTokens)} (${formatPercent(summary.avgSavingsPercent)})`
  );
  lines.push(
    `${padSummaryLabel("Total exec time:")}${formatDuration(summary.totalExecMs)} (avg ${formatDuration(summary.avgExecMs)})`
  );
  lines.push(
    `${padSummaryLabel("Efficiency meter:")}${renderProgressBar(summary.avgSavingsPercent)} ${formatPercent(summary.avgSavingsPercent)}`
  );
  lines.push(
    `${padSummaryLabel("Rewrite rate:")}${metrics.rewritesApplied}/${metrics.rewriteAttempts} (${metrics.rewriteRatePercent}%) · fallbacks ${metrics.rewriteFallbacks}`
  );
  lines.push(
    `${padSummaryLabel("User !cmd:")}${metrics.userBashRewrites}/${metrics.userBashAttempts} rewrites (${metrics.userBashRewriteRatePercent}%)`
  );

  return lines;
}

function buildTableLines(
  metrics: PiRtkMetricsSnapshot,
  width: number
): string[] {
  const rows = metrics.commands.slice(0, MAX_TABLE_ROWS);
  const rankWidth = rows.length >= 10 ? 4 : 3;
  const countWidth = 5;
  const savedWidth = 8;
  const avgWidth = 7;
  const timeWidth = 9;
  const commandWidth = Math.max(
    16,
    width - (rankWidth + countWidth + savedWidth + avgWidth + timeWidth + 5)
  );

  const header = [
    "By Command",
    "",
    `${"#".padEnd(rankWidth)} ${"Command".padEnd(commandWidth)} ${"Count".padStart(countWidth)} ${"Saved".padStart(savedWidth)} ${"Avg%".padStart(avgWidth)} ${"Time".padStart(timeWidth)}`,
    `${repeat("-", rankWidth)} ${repeat("-", commandWidth)} ${repeat("-", countWidth)} ${repeat("-", savedWidth)} ${repeat("-", avgWidth)} ${repeat("-", timeWidth)}`,
  ];

  if (rows.length === 0) {
    return [...header, "No command rows yet."];
  }

  const lines = rows.map((command, index) => {
    const rank = `${index + 1}.`.padEnd(rankWidth);
    return `${rank} ${formatCommandLabel(command, commandWidth).padEnd(commandWidth)} ${String(command.count).padStart(countWidth)} ${formatTokens(command.savedTokens).padStart(savedWidth)} ${formatPercent(command.savingsPercent).padStart(avgWidth)} ${formatDuration(command.avgExecMs).padStart(timeWidth)}`;
  });

  if (metrics.commands.length > rows.length) {
    lines.push(
      `+ ${metrics.commands.length - rows.length} more command row(s)`
    );
  }

  return [...header, ...lines];
}

function buildImpactChartLines(
  metrics: PiRtkMetricsSnapshot,
  width: number
): string[] {
  const rows = metrics.impactChart;
  const barWidth = Math.max(8, width - 18);
  const lines = ["Impact chart", ""];

  if (rows.length === 0) {
    return [...lines, "No saved-token impact yet."];
  }

  for (const [index, row] of rows.entries()) {
    const label = truncatePlain(row.label, Math.max(8, width - 20));
    lines.push(`${index + 1}. ${label}`);
    lines.push(
      `   ${renderProgressBar(row.sharePercent, barWidth)} ${formatPercent(row.sharePercent)}`
    );
  }

  return lines;
}

function mergeColumns(
  left: string[],
  right: string[],
  width: number,
  gap = 3
): string[] {
  const leftWidth = Math.max(
    0,
    Math.min(
      width - gap - 16,
      left.reduce((max, line) => Math.max(max, visibleWidth(line)), 0)
    )
  );
  const rightWidth = Math.max(16, width - leftWidth - gap);
  const rows = Math.max(left.length, right.length);
  const lines: string[] = [];

  for (let index = 0; index < rows; index += 1) {
    const leftLine = truncateToWidth(left[index] ?? "", leftWidth);
    const rightLine = truncateToWidth(right[index] ?? "", rightWidth);
    const paddedLeft = `${leftLine}${" ".repeat(
      Math.max(0, leftWidth - visibleWidth(leftLine) + gap)
    )}`;
    lines.push(truncateToWidth(`${paddedLeft}${rightLine}`, width));
  }

  return lines;
}

function buildBodyLines(
  metrics: PiRtkMetricsSnapshot,
  config: PiRtkConfig,
  width: number
): string[] {
  const summary = buildSummaryLines(metrics, config);
  const table = buildTableLines(metrics, Math.max(TABLE_MIN_WIDTH, width));
  const impact = buildImpactChartLines(
    metrics,
    Math.max(24, Math.floor(width * 0.3))
  );

  if (width >= SIDE_BY_SIDE_WIDTH) {
    const mergedTable = mergeColumns(table, impact, width, 4);
    return [...summary, "", ...mergedTable];
  }

  return [...summary, "", ...table, "", ...impact];
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

function frameLine(content: string, width: number): string {
  const innerWidth = Math.max(0, width - 4);
  const clipped = truncateToWidth(content, innerWidth);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  return `│ ${clipped}${padding} │`;
}

function border(
  width: number,
  left: string,
  fill: string,
  right: string
): string {
  return `${left}${fill.repeat(Math.max(0, width - 2))}${right}`;
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

function decorateLines(lines: string[], theme: any): string[] {
  return lines.map((line) => {
    if (
      line === "RTK Token Savings (Session Scope)" ||
      line === "By Command" ||
      line === "Impact chart"
    ) {
      return theme.bold(theme.fg("toolTitle", line));
    }

    if (line === "Estimated tokens · session-only · screenshot-inspired") {
      return theme.fg("muted", line);
    }

    if (
      line.startsWith("RTK is disabled") ||
      line.startsWith("Output compaction is off") ||
      line.startsWith("Savings tracking is off")
    ) {
      return theme.fg("warning", line);
    }

    if (
      line.startsWith("No session savings yet") ||
      line.startsWith("No command rows yet") ||
      line.startsWith("No saved-token impact yet")
    ) {
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
          decorateLines(buildBodyLines(metrics, config, width), theme),
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
            border(frameWidth, "╭", "─", "╮"),
            frameLine(theme.bold(theme.fg("accent", "/rtk stats")), frameWidth),
            frameLine(
              theme.fg("dim", "Session-only dashboard · estimated tokens"),
              frameWidth
            ),
            border(frameWidth, "├", "─", "┤"),
            ...visibleBody.map((line) => frameLine(line, frameWidth)),
          ];

          while (lines.length < bodyHeight + 4) {
            lines.push(frameLine("", frameWidth));
          }

          lines.push(border(frameWidth, "├", "─", "┤"));
          lines.push(
            frameLine(
              theme.fg(
                "dim",
                buildStatusLine(scroll, visibleBody.length, body.length)
              ),
              frameWidth
            )
          );
          lines.push(border(frameWidth, "╰", "─", "╯"));
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
