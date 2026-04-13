export type RtkMode = "rewrite" | "suggest";
export type RtkToolName = "bash" | "grep" | "read";
export type RtkTrackedToolName = RtkToolName | "user-bash";
export type RtkRewriteStatus =
  | "disabled"
  | "suggest"
  | "guarded"
  | "rewritten"
  | "unchanged"
  | "fallback";

export interface RtkOutputCompactionConfig {
  enabled: boolean;
  compactBash: boolean;
  compactGrep: boolean;
  compactRead: boolean;
  readSourceFilteringEnabled: boolean;
  maxLines: number;
  maxChars: number;
  trackSavings: boolean;
}

export interface RtkConfig {
  enabled: boolean;
  mode: RtkMode;
  guardWhenRtkMissing: boolean;
  showRewriteNotifications: boolean;
  outputCompaction: RtkOutputCompactionConfig;
}

export interface RtkRuntimeStatus {
  rtkAvailable: boolean;
  lastCheckedAt?: string;
  lastError?: string;
}

export interface RtkToolSavings {
  calls: number;
  originalChars: number;
  finalChars: number;
}

export interface RtkStatsRow {
  label: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  savingsPercent: number;
  totalExecMs: number;
  avgExecMs: number;
}

export interface RtkCommandMetrics extends RtkStatsRow {
  toolName: RtkTrackedToolName;
}

export interface RtkMetricsSummary {
  totalCommands: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSavedTokens: number;
  avgSavingsPercent: number;
  totalExecMs: number;
  avgExecMs: number;
}

export interface RtkMetricsSnapshot {
  rewriteAttempts: number;
  rewritesApplied: number;
  rewriteFallbacks: number;
  userBashAttempts: number;
  userBashRewrites: number;
  toolSavingsByName: Record<string, RtkToolSavings>;
  totalOriginalChars: number;
  totalFinalChars: number;
  totalSavedChars: number;
  overallSavingsPercent: number;
  rewriteRatePercent: number;
  fallbackRatePercent: number;
  userBashRewriteRatePercent: number;
  summary: RtkMetricsSummary;
  tools: RtkStatsRow[];
  commandFamilies: RtkStatsRow[];
  commands: RtkCommandMetrics[];
  hasCommandData: boolean;
}

export interface RtkCommandCompletionOptions {
  label?: string;
  inputText?: string;
  outputText?: string;
  endedAt?: number;
  execMs?: number;
}

export interface RtkMetricsStore {
  recordRewriteAttempt(): void;
  recordRewriteApplied(): void;
  recordRewriteFallback(): void;
  recordUserBashAttempt(): void;
  recordUserBashRewrite(): void;
  recordToolSavings(
    toolName: RtkToolName | string,
    originalChars: number,
    finalChars: number
  ): void;
  startCommand(
    commandId: string,
    toolName: RtkTrackedToolName,
    label: string,
    startedAt?: number
  ): void;
  completeCommand(
    commandId: string,
    options?: RtkCommandCompletionOptions
  ): void;
  reset(): void;
  snapshot(): RtkMetricsSnapshot;
}

export interface RtkRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

export type RtkRunner = (
  file: string,
  args: string[],
  timeoutMs: number
) => RtkRunnerResult;

export interface RtkRewriteResult {
  rewritten: string;
  changed: boolean;
}

export interface RtkRewriteResolution {
  status: RtkRewriteStatus;
  command: string;
  changed: boolean;
  reason?: string;
}

export interface RtkRuntime {
  getConfig(): RtkConfig;
  setConfig(config: RtkConfig): void;
  getStatus(): RtkRuntimeStatus;
  setStatus(status: RtkRuntimeStatus): void;
  refreshRtkStatus(): RtkRuntimeStatus;
  resetSessionState(): void;
  metrics: RtkMetricsStore;
}
