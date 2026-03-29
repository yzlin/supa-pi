import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";

import type {
  PiRtkCommandCompletionOptions,
  PiRtkCommandMetrics,
  PiRtkImpactChartDatum,
  PiRtkMetricsSnapshot,
  PiRtkMetricsStore,
  PiRtkToolName,
  PiRtkToolSavings,
  PiRtkTrackedToolName,
} from "./types";

const DEFAULT_TOOL_NAMES = ["bash", "grep", "read"] as const;
const MAX_IMPACT_CHART_POINTS = 8;

interface MutablePiRtkCommandMetrics {
  label: string;
  toolName: PiRtkTrackedToolName;
  count: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  totalExecMs: number;
}

interface MutablePendingCommand {
  label: string;
  toolName: PiRtkTrackedToolName;
  startedAt: number;
}

interface MutablePiRtkMetricsState {
  rewriteAttempts: number;
  rewritesApplied: number;
  rewriteFallbacks: number;
  userBashAttempts: number;
  userBashRewrites: number;
  toolSavingsByName: Record<string, PiRtkToolSavings>;
  totalOriginalChars: number;
  totalFinalChars: number;
  commandMetricsByKey: Record<string, MutablePiRtkCommandMetrics>;
  pendingCommands: Record<string, MutablePendingCommand>;
}

function createSyntheticUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: 0,
  } as AgentMessage;
}

function estimateTextTokens(text: string | undefined): number {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return 0;
  }

  return estimateTokens(createSyntheticUserMessage(trimmed));
}

function createEmptyToolSavings(): PiRtkToolSavings {
  return {
    calls: 0,
    originalChars: 0,
    finalChars: 0,
  };
}

function createEmptyState(): MutablePiRtkMetricsState {
  const toolSavingsByName = Object.create(null) as Record<
    string,
    PiRtkToolSavings
  >;
  for (const toolName of DEFAULT_TOOL_NAMES) {
    toolSavingsByName[toolName] = createEmptyToolSavings();
  }

  return {
    rewriteAttempts: 0,
    rewritesApplied: 0,
    rewriteFallbacks: 0,
    userBashAttempts: 0,
    userBashRewrites: 0,
    toolSavingsByName,
    totalOriginalChars: 0,
    totalFinalChars: 0,
    commandMetricsByKey: Object.create(null) as Record<
      string,
      MutablePiRtkCommandMetrics
    >,
    pendingCommands: Object.create(null) as Record<
      string,
      MutablePendingCommand
    >,
  };
}

function cloneToolSavingsMap(
  input: Record<string, PiRtkToolSavings>
): Record<string, PiRtkToolSavings> {
  return Object.fromEntries(
    Object.entries(input).map(([toolName, savings]) => [
      toolName,
      { ...savings },
    ])
  );
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

function roundToTenths(value: number): number {
  return Math.round(value * 10) / 10;
}

function toPercent(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Math.round((part / total) * 100);
}

function toPrecisePercent(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return roundToTenths((part / total) * 100);
}

function getOrCreateToolSavings(
  state: MutablePiRtkMetricsState,
  toolName: PiRtkToolName | string
): PiRtkToolSavings {
  const existing = state.toolSavingsByName[toolName];
  if (existing) {
    return existing;
  }

  const created = createEmptyToolSavings();
  state.toolSavingsByName[toolName] = created;
  return created;
}

function normalizeCommandLabel(label: string): string {
  const normalized = label.replace(/\s+/g, " ").trim();
  return normalized || "(unknown)";
}

function getCommandMetricsKey(
  toolName: PiRtkTrackedToolName,
  label: string
): string {
  return `${toolName}:${label}`;
}

function getOrCreateCommandMetrics(
  state: MutablePiRtkMetricsState,
  toolName: PiRtkTrackedToolName,
  label: string
): MutablePiRtkCommandMetrics {
  const key = getCommandMetricsKey(toolName, label);
  const existing = state.commandMetricsByKey[key];
  if (existing) {
    return existing;
  }

  const created: MutablePiRtkCommandMetrics = {
    label,
    toolName,
    count: 0,
    inputTokens: 0,
    outputTokens: 0,
    savedTokens: 0,
    totalExecMs: 0,
  };
  state.commandMetricsByKey[key] = created;
  return created;
}

function compareCommands(
  left: PiRtkCommandMetrics,
  right: PiRtkCommandMetrics
): number {
  return (
    right.savedTokens - left.savedTokens ||
    right.inputTokens - left.inputTokens ||
    right.count - left.count ||
    right.totalExecMs - left.totalExecMs ||
    left.label.localeCompare(right.label)
  );
}

function toCommandMetrics(
  row: MutablePiRtkCommandMetrics
): PiRtkCommandMetrics {
  return {
    label: row.label,
    toolName: row.toolName,
    count: row.count,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    savedTokens: row.savedTokens,
    savingsPercent: toPrecisePercent(row.savedTokens, row.inputTokens),
    totalExecMs: row.totalExecMs,
    avgExecMs:
      row.count > 0 ? Math.round(row.totalExecMs / row.count) : row.totalExecMs,
  };
}

function buildImpactChart(
  commands: PiRtkCommandMetrics[]
): PiRtkImpactChartDatum[] {
  const ranked = commands.filter((command) => command.savedTokens > 0);
  const totalSavedTokens = ranked.reduce(
    (sum, command) => sum + command.savedTokens,
    0
  );

  let cumulativeSavedTokens = 0;
  return ranked.slice(0, MAX_IMPACT_CHART_POINTS).map((command) => {
    cumulativeSavedTokens += command.savedTokens;
    return {
      label: command.label,
      savedTokens: command.savedTokens,
      sharePercent: toPrecisePercent(command.savedTokens, totalSavedTokens),
      cumulativeSharePercent: toPrecisePercent(
        cumulativeSavedTokens,
        totalSavedTokens
      ),
    };
  });
}

export function createPiRtkMetricsStore(): PiRtkMetricsStore {
  let state = createEmptyState();

  return {
    recordRewriteAttempt() {
      state.rewriteAttempts += 1;
    },

    recordRewriteApplied() {
      state.rewritesApplied += 1;
    },

    recordRewriteFallback() {
      state.rewriteFallbacks += 1;
    },

    recordUserBashAttempt() {
      state.userBashAttempts += 1;
    },

    recordUserBashRewrite() {
      state.userBashRewrites += 1;
    },

    recordToolSavings(toolName, originalChars, finalChars) {
      const normalizedOriginal = clampNonNegative(originalChars);
      const normalizedFinal = clampNonNegative(finalChars);
      const toolSavings = getOrCreateToolSavings(state, toolName);

      toolSavings.calls += 1;
      toolSavings.originalChars += normalizedOriginal;
      toolSavings.finalChars += normalizedFinal;
      state.totalOriginalChars += normalizedOriginal;
      state.totalFinalChars += normalizedFinal;
    },

    startCommand(commandId, toolName, label, startedAt = Date.now()) {
      state.pendingCommands[commandId] = {
        label: normalizeCommandLabel(label),
        toolName,
        startedAt,
      };
    },

    completeCommand(commandId, options: PiRtkCommandCompletionOptions = {}) {
      const pending = state.pendingCommands[commandId];
      if (!pending) {
        return;
      }

      delete state.pendingCommands[commandId];

      const label = normalizeCommandLabel(options.label ?? pending.label);
      const row = getOrCreateCommandMetrics(state, pending.toolName, label);
      const inputTokens = estimateTextTokens(options.inputText);
      const outputTokens = estimateTextTokens(options.outputText);
      const savedTokens = Math.max(0, inputTokens - outputTokens);
      const execMs = clampNonNegative(
        options.execMs ??
          (options.endedAt ?? Date.now()) - clampNonNegative(pending.startedAt)
      );

      row.count += 1;
      row.inputTokens += inputTokens;
      row.outputTokens += outputTokens;
      row.savedTokens += savedTokens;
      row.totalExecMs += execMs;
    },

    reset() {
      state = createEmptyState();
    },

    snapshot(): PiRtkMetricsSnapshot {
      const totalSavedChars = Math.max(
        0,
        state.totalOriginalChars - state.totalFinalChars
      );
      const commands = Object.values(state.commandMetricsByKey)
        .map(toCommandMetrics)
        .sort(compareCommands);
      const summary = commands.reduce(
        (totals, command) => {
          totals.totalCommands += command.count;
          totals.totalInputTokens += command.inputTokens;
          totals.totalOutputTokens += command.outputTokens;
          totals.totalSavedTokens += command.savedTokens;
          totals.totalExecMs += command.totalExecMs;
          return totals;
        },
        {
          totalCommands: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalSavedTokens: 0,
          avgSavingsPercent: 0,
          totalExecMs: 0,
          avgExecMs: 0,
        }
      );

      summary.avgSavingsPercent = toPrecisePercent(
        summary.totalSavedTokens,
        summary.totalInputTokens
      );
      summary.avgExecMs =
        summary.totalCommands > 0
          ? Math.round(summary.totalExecMs / summary.totalCommands)
          : 0;

      return {
        rewriteAttempts: state.rewriteAttempts,
        rewritesApplied: state.rewritesApplied,
        rewriteFallbacks: state.rewriteFallbacks,
        userBashAttempts: state.userBashAttempts,
        userBashRewrites: state.userBashRewrites,
        toolSavingsByName: cloneToolSavingsMap(state.toolSavingsByName),
        totalOriginalChars: state.totalOriginalChars,
        totalFinalChars: state.totalFinalChars,
        totalSavedChars,
        overallSavingsPercent: toPercent(
          totalSavedChars,
          state.totalOriginalChars
        ),
        rewriteRatePercent: toPercent(
          state.rewritesApplied,
          state.rewriteAttempts
        ),
        fallbackRatePercent: toPercent(
          state.rewriteFallbacks,
          state.rewriteAttempts
        ),
        userBashRewriteRatePercent: toPercent(
          state.userBashRewrites,
          state.userBashAttempts
        ),
        summary,
        commands,
        impactChart: buildImpactChart(commands),
        hasCommandData: summary.totalCommands > 0,
      };
    },
  };
}
