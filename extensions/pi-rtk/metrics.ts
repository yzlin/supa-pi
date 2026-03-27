import type {
  PiRtkMetricsSnapshot,
  PiRtkMetricsStore,
  PiRtkToolName,
  PiRtkToolSavings,
} from "./types";

const DEFAULT_TOOL_NAMES = ["bash", "grep", "read"] as const;

interface MutablePiRtkMetricsState {
  rewriteAttempts: number;
  rewritesApplied: number;
  rewriteFallbacks: number;
  userBashAttempts: number;
  userBashRewrites: number;
  toolSavingsByName: Record<string, PiRtkToolSavings>;
  totalOriginalChars: number;
  totalFinalChars: number;
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

function toPercent(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Math.round((part / total) * 100);
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

    reset() {
      state = createEmptyState();
    },

    snapshot(): PiRtkMetricsSnapshot {
      const totalSavedChars = Math.max(
        0,
        state.totalOriginalChars - state.totalFinalChars
      );

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
      };
    },
  };
}
