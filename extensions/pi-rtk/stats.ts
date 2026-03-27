import type {
  PiRtkConfig,
  PiRtkMetricsSnapshot,
  PiRtkToolName,
  PiRtkToolSavings,
} from "./types";

const BAR_WIDTH = 10;
const LABEL_WIDTH = 16;
const EMPTY_TOOL_SAVINGS: PiRtkToolSavings = {
  calls: 0,
  originalChars: 0,
  finalChars: 0,
};

function repeat(char: string, count: number): string {
  return char.repeat(Math.max(0, count));
}

function formatPercent(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function formatRatio(numerator: number, denominator: number): string {
  return `${numerator}/${denominator}`;
}

function formatChars(original: number, final: number): string {
  return `${original}→${final} chars`;
}

function formatBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  return `${repeat("█", filled)}${repeat("░", BAR_WIDTH - filled)}`;
}

function formatRow(
  label: string,
  state: { kind: "off" | "percent"; percent?: number; detail?: string }
): string {
  const left = label.padEnd(LABEL_WIDTH, " ");
  if (state.kind === "off") {
    return `${left} ${repeat("░", BAR_WIDTH)} off${state.detail ? ` ${state.detail}` : ""}`;
  }

  const percent = state.percent ?? 0;
  return `${left} ${formatBar(percent)} ${formatPercent(percent)}${state.detail ? ` ${state.detail}` : ""}`;
}

function renderSavingsRow(
  label: string,
  enabled: boolean,
  savings: PiRtkToolSavings
): string {
  if (!enabled) {
    return formatRow(label, { kind: "off" });
  }

  if (savings.calls === 0 || savings.originalChars === 0) {
    return formatRow(label, {
      kind: "percent",
      percent: 0,
      detail: "(no data)",
    });
  }

  const savedChars = Math.max(0, savings.originalChars - savings.finalChars);
  const percent = Math.round((savedChars / savings.originalChars) * 100);

  return formatRow(label, {
    kind: "percent",
    percent,
    detail: `${formatChars(savings.originalChars, savings.finalChars)} in ${savings.calls} call(s)`,
  });
}

export function renderProgressBar(percent: number, width = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * width);
  return `${repeat("█", filled)}${repeat("░", width - filled)}`;
}

function getToolSavings(
  metrics: PiRtkMetricsSnapshot,
  toolName: PiRtkToolName
): PiRtkToolSavings {
  return metrics.toolSavingsByName[toolName] ?? EMPTY_TOOL_SAVINGS;
}

export function renderRtkStats(
  metrics: PiRtkMetricsSnapshot,
  config: PiRtkConfig
): string {
  const lines = ["RTK stats"];
  const hasAnyActivity =
    metrics.rewriteAttempts > 0 ||
    metrics.userBashAttempts > 0 ||
    metrics.totalOriginalChars > 0;

  if (!hasAnyActivity) {
    lines.push("No data yet.");
  }

  const savingsEnabled =
    config.outputCompaction.enabled && config.outputCompaction.trackSavings;

  lines.push(
    formatRow("overall savings", {
      kind: savingsEnabled ? "percent" : "off",
      percent: metrics.overallSavingsPercent,
      detail: savingsEnabled
        ? `${formatChars(metrics.totalOriginalChars, metrics.totalFinalChars)}`
        : undefined,
    })
  );

  lines.push(
    formatRow("rewrites", {
      kind: "percent",
      percent: metrics.rewriteRatePercent,
      detail: `(${formatRatio(metrics.rewritesApplied, metrics.rewriteAttempts)})`,
    })
  );

  lines.push(
    formatRow("fallbacks", {
      kind: "percent",
      percent: metrics.fallbackRatePercent,
      detail: `(${formatRatio(metrics.rewriteFallbacks, metrics.rewriteAttempts)})`,
    })
  );

  lines.push(
    formatRow("user !cmd", {
      kind: "percent",
      percent: metrics.userBashRewriteRatePercent,
      detail: `(${formatRatio(metrics.userBashRewrites, metrics.userBashAttempts)})`,
    })
  );

  lines.push(
    renderSavingsRow(
      "bash savings",
      config.outputCompaction.enabled && config.outputCompaction.compactBash,
      getToolSavings(metrics, "bash")
    )
  );

  lines.push(
    renderSavingsRow(
      "grep savings",
      config.outputCompaction.enabled && config.outputCompaction.compactGrep,
      getToolSavings(metrics, "grep")
    )
  );

  lines.push(
    renderSavingsRow(
      "read savings",
      config.outputCompaction.enabled && config.outputCompaction.compactRead,
      getToolSavings(metrics, "read")
    )
  );

  lines.push(
    `total calls      ${metrics.rewriteAttempts + metrics.userBashAttempts}`
  );

  return lines.join("\n");
}
