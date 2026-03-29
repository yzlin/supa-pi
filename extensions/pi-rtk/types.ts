export type PiRtkMode = "rewrite" | "suggest";
export type PiRtkToolName = "bash" | "grep" | "read";
export type PiRtkTrackedToolName = PiRtkToolName | "user-bash";
export type PiRtkRewriteStatus =
  | "disabled"
  | "suggest"
  | "guarded"
  | "rewritten"
  | "unchanged"
  | "fallback";

export interface PiRtkOutputCompactionConfig {
  enabled: boolean;
  compactBash: boolean;
  compactGrep: boolean;
  compactRead: boolean;
  readSourceFilteringEnabled: boolean;
  maxLines: number;
  maxChars: number;
  trackSavings: boolean;
}

export interface PiRtkConfig {
  enabled: boolean;
  mode: PiRtkMode;
  guardWhenRtkMissing: boolean;
  showRewriteNotifications: boolean;
  outputCompaction: PiRtkOutputCompactionConfig;
}

export interface PiRtkRuntimeStatus {
  rtkAvailable: boolean;
  lastCheckedAt?: string;
  lastError?: string;
}

export interface PiRtkToolSavings {
  calls: number;
  originalChars: number;
  finalChars: number;
}

export interface PiRtkCommandMetrics {
  label: string;
  toolName: PiRtkTrackedToolName;
  count: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  savingsPercent: number;
  totalExecMs: number;
  avgExecMs: number;
}

export interface PiRtkImpactChartDatum {
  label: string;
  savedTokens: number;
  sharePercent: number;
  cumulativeSharePercent: number;
}

export interface PiRtkMetricsSummary {
  totalCommands: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSavedTokens: number;
  avgSavingsPercent: number;
  totalExecMs: number;
  avgExecMs: number;
}

export interface PiRtkMetricsSnapshot {
  rewriteAttempts: number;
  rewritesApplied: number;
  rewriteFallbacks: number;
  userBashAttempts: number;
  userBashRewrites: number;
  toolSavingsByName: Record<string, PiRtkToolSavings>;
  totalOriginalChars: number;
  totalFinalChars: number;
  totalSavedChars: number;
  overallSavingsPercent: number;
  rewriteRatePercent: number;
  fallbackRatePercent: number;
  userBashRewriteRatePercent: number;
  summary: PiRtkMetricsSummary;
  commands: PiRtkCommandMetrics[];
  impactChart: PiRtkImpactChartDatum[];
  hasCommandData: boolean;
}

export interface PiRtkCommandCompletionOptions {
  label?: string;
  inputText?: string;
  outputText?: string;
  endedAt?: number;
  execMs?: number;
}

export interface PiRtkMetricsStore {
  recordRewriteAttempt(): void;
  recordRewriteApplied(): void;
  recordRewriteFallback(): void;
  recordUserBashAttempt(): void;
  recordUserBashRewrite(): void;
  recordToolSavings(
    toolName: PiRtkToolName | string,
    originalChars: number,
    finalChars: number
  ): void;
  startCommand(
    commandId: string,
    toolName: PiRtkTrackedToolName,
    label: string,
    startedAt?: number
  ): void;
  completeCommand(
    commandId: string,
    options?: PiRtkCommandCompletionOptions
  ): void;
  reset(): void;
  snapshot(): PiRtkMetricsSnapshot;
}

export interface PiRtkRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

export type PiRtkRunner = (
  file: string,
  args: string[],
  timeoutMs: number
) => PiRtkRunnerResult;

export interface PiRtkRewriteResult {
  rewritten: string;
  changed: boolean;
}

export interface PiRtkRewriteResolution {
  status: PiRtkRewriteStatus;
  command: string;
  changed: boolean;
  reason?: string;
}

export interface PiRtkRuntime {
  getConfig(): PiRtkConfig;
  setConfig(config: PiRtkConfig): void;
  getStatus(): PiRtkRuntimeStatus;
  setStatus(status: PiRtkRuntimeStatus): void;
  refreshRtkStatus(): PiRtkRuntimeStatus;
  resetSessionState(): void;
  metrics: PiRtkMetricsStore;
}
