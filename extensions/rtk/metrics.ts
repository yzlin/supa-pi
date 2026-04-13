import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";

import type {
  RtkCommandCompletionOptions,
  RtkCommandMetrics,
  RtkMetricsSnapshot,
  RtkMetricsStore,
  RtkStatsRow,
  RtkToolName,
  RtkToolSavings,
  RtkTrackedToolName,
} from "./types";

const DEFAULT_TOOL_NAMES = ["bash", "grep", "read"] as const;
const COMPOUND_COMMAND_FAMILY_NAMES = [
  "git",
  "gh",
  "npm",
  "pnpm",
  "bun",
  "cargo",
  "python",
] as const;

interface MutableRtkCommandMetrics {
  label: string;
  toolName: RtkTrackedToolName;
  count: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  totalExecMs: number;
}

interface MutablePendingCommand {
  label: string;
  toolName: RtkTrackedToolName;
  startedAt: number;
}

interface MutableRtkStatsRow {
  label: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  totalExecMs: number;
}

interface MutableRtkMetricsState {
  rewriteAttempts: number;
  rewritesApplied: number;
  rewriteFallbacks: number;
  userBashAttempts: number;
  userBashRewrites: number;
  toolSavingsByName: Record<string, RtkToolSavings>;
  totalOriginalChars: number;
  totalFinalChars: number;
  commandMetricsByKey: Record<string, MutableRtkCommandMetrics>;
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

function createEmptyToolSavings(): RtkToolSavings {
  return {
    calls: 0,
    originalChars: 0,
    finalChars: 0,
  };
}

function createEmptyState(): MutableRtkMetricsState {
  const toolSavingsByName = Object.create(null) as Record<
    string,
    RtkToolSavings
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
      MutableRtkCommandMetrics
    >,
    pendingCommands: Object.create(null) as Record<
      string,
      MutablePendingCommand
    >,
  };
}

function cloneToolSavingsMap(
  input: Record<string, RtkToolSavings>
): Record<string, RtkToolSavings> {
  return Object.fromEntries(
    Object.entries(input).map(([toolName, savings]) => [
      toolName,
      { ...savings },
    ])
  );
}

function createEmptyStatsRow(label: string): MutableRtkStatsRow {
  return {
    label,
    count: 0,
    inputTokens: 0,
    outputTokens: 0,
    savedTokens: 0,
    totalExecMs: 0,
  };
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
  state: MutableRtkMetricsState,
  toolName: RtkToolName | string
): RtkToolSavings {
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
  toolName: RtkTrackedToolName,
  label: string
): string {
  return `${toolName}:${label}`;
}

function getOrCreateCommandMetrics(
  state: MutableRtkMetricsState,
  toolName: RtkTrackedToolName,
  label: string
): MutableRtkCommandMetrics {
  const key = getCommandMetricsKey(toolName, label);
  const existing = state.commandMetricsByKey[key];
  if (existing) {
    return existing;
  }

  const created: MutableRtkCommandMetrics = {
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

function compareStatsRows(
  left: Pick<
    RtkStatsRow,
    "label" | "savedTokens" | "inputTokens" | "count" | "totalExecMs"
  >,
  right: Pick<
    RtkStatsRow,
    "label" | "savedTokens" | "inputTokens" | "count" | "totalExecMs"
  >
): number {
  return (
    right.savedTokens - left.savedTokens ||
    right.inputTokens - left.inputTokens ||
    right.count - left.count ||
    right.totalExecMs - left.totalExecMs ||
    left.label.localeCompare(right.label)
  );
}

function toStatsRow(row: MutableRtkStatsRow): RtkStatsRow {
  return {
    label: row.label,
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

function toCommandMetrics(
  row: MutableRtkCommandMetrics
): RtkCommandMetrics {
  return {
    ...toStatsRow(row),
    toolName: row.toolName,
  };
}

function normalizeCommandFamilyToken(token: string): string {
  return token.replace(/^["'`]+|["'`]+$/g, "");
}

function getCommandFamilyLabel(
  toolName: RtkTrackedToolName,
  label: string
): string {
  if (toolName === "read" || toolName === "grep") {
    return toolName;
  }

  const tokens = label
    .split(/\s+/)
    .map(normalizeCommandFamilyToken)
    .filter(Boolean);

  if (tokens[0] === "rtk") {
    tokens.shift();
  }

  if (tokens.length === 0) {
    return "(unknown)";
  }

  const [first, second] = tokens;
  if (
    second &&
    !second.startsWith("-") &&
    COMPOUND_COMMAND_FAMILY_NAMES.includes(first)
  ) {
    return `${first} ${second}`;
  }

  return first;
}

function aggregateStatsRows<T extends MutableRtkCommandMetrics>(
  rows: T[],
  getLabel: (row: T) => string
): RtkStatsRow[] {
  const aggregates = Object.create(null) as Record<
    string,
    MutableRtkStatsRow
  >;

  for (const row of rows) {
    const label = getLabel(row);
    const aggregate = aggregates[label] ?? createEmptyStatsRow(label);

    aggregate.count += row.count;
    aggregate.inputTokens += row.inputTokens;
    aggregate.outputTokens += row.outputTokens;
    aggregate.savedTokens += row.savedTokens;
    aggregate.totalExecMs += row.totalExecMs;
    aggregates[label] = aggregate;
  }

  return Object.values(aggregates).map(toStatsRow).sort(compareStatsRows);
}

function createEmptySummary(): RtkMetricsSnapshot["summary"] {
  return {
    totalCommands: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalSavedTokens: 0,
    avgSavingsPercent: 0,
    totalExecMs: 0,
    avgExecMs: 0,
  };
}

function buildSummary(
  commands: RtkCommandMetrics[]
): RtkMetricsSnapshot["summary"] {
  const summary = commands.reduce((totals, command) => {
    totals.totalCommands += command.count;
    totals.totalInputTokens += command.inputTokens;
    totals.totalOutputTokens += command.outputTokens;
    totals.totalSavedTokens += command.savedTokens;
    totals.totalExecMs += command.totalExecMs;
    return totals;
  }, createEmptySummary());

  summary.avgSavingsPercent = toPrecisePercent(
    summary.totalSavedTokens,
    summary.totalInputTokens
  );
  summary.avgExecMs =
    summary.totalCommands > 0
      ? Math.round(summary.totalExecMs / summary.totalCommands)
      : 0;

  return summary;
}

export function createRtkMetricsStore(): RtkMetricsStore {
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

    completeCommand(commandId, options: RtkCommandCompletionOptions = {}) {
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

    snapshot(): RtkMetricsSnapshot {
      const totalSavedChars = Math.max(
        0,
        state.totalOriginalChars - state.totalFinalChars
      );
      const commandRows = Object.values(state.commandMetricsByKey);
      const commands = commandRows.map(toCommandMetrics).sort(compareStatsRows);
      const tools = aggregateStatsRows(commandRows, (row) => row.toolName);
      const commandFamilies = aggregateStatsRows(commandRows, (row) =>
        getCommandFamilyLabel(row.toolName, row.label)
      );
      const summary = buildSummary(commands);

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
        tools,
        commandFamilies,
        commands,
        hasCommandData: summary.totalCommands > 0,
      };
    },
  };
}
