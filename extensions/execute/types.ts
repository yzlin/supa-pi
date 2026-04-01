import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import type { ensureRuntime } from "../../../pi-lcm/src/runtime.ts";
import type { MapTaskProgressEvent } from "../../../pi-lcm/src/map-runner.ts";
import type { MapResultRecord } from "../../../pi-lcm/src/types.ts";

export interface ExecuteStepResult {
  status: "done" | "blocked" | "needs_followup";
  summary: string;
  filesTouched: string[];
  validation: string[];
  followUps: string[];
  blockers: string[];
}

export interface ExecuteTaskSnapshot {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  owner?: string;
  metadata: Record<string, unknown>;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ExecuteTaskUpdateResult {
  task?: ExecuteTaskSnapshot;
  changedFields: string[];
  warnings: string[];
}

export interface ExecuteTaskCreateInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecuteTaskUpdateInput {
  taskId: string;
  status?: "pending" | "in_progress" | "completed";
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
  addBlocks?: string[];
  addBlockedBy?: string[];
}

export interface ExecuteTasksBridge {
  isAvailable(): boolean;
  createTask(
    input: ExecuteTaskCreateInput
  ): Promise<ExecuteTaskSnapshot | undefined>;
  updateTask(
    input: ExecuteTaskUpdateInput
  ): Promise<ExecuteTaskUpdateResult | undefined>;
  setTaskActive(taskId: string, active: boolean): Promise<boolean>;
}

export interface ExecuteRpcContextPayload {
  uiCtx: ExtensionCommandContext["ui"];
  sessionId: string;
}

export interface ExecuteQueuedItem {
  item: string;
  taskId?: string;
  parentTaskId?: string;
}

export interface ExecutePlanDigestInput {
  rawArgs: string;
  directive: string;
  sourceText: string;
  sourceLabel: string;
  fallbackItems: string[];
}

export interface ExecuteCompletedItem {
  item: string;
  status: ExecuteStepResult["status"];
  summary: string;
}

export interface ExecuteBlockedItem {
  item: string;
  reason: string;
}

export interface ExecuteStructuredResultSummary {
  completed: ExecuteCompletedItem | null;
  blocked: ExecuteBlockedItem | null;
  filesTouched: string[];
  validation: string[];
  followUps: string[];
}

export interface ExecuteWaveSummary {
  wave: number;
  jobId: string;
  totalItems: number;
  completedItems: number;
  errorCount: number;
  queuedFollowUps: number;
}

export interface ExecuteSummaryDetails {
  planItems: string[];
  waves: ExecuteWaveSummary[];
  completed: ExecuteCompletedItem[];
  blocked: ExecuteBlockedItem[];
  filesTouched: string[];
  validation: string[];
  remainingFollowUps: string[];
}

export interface ExecuteWidgetWaveState {
  wave: number;
  totalItems: number;
  completedItems: number;
  errorCount: number;
  queuedFollowUps: number;
  activeItem?: string;
}

export interface ExecuteProgressWidgetState {
  completedItems: number;
  blockedItems: number;
  remainingItems: number;
  activeWave?: ExecuteWidgetWaveState;
  waves: ExecuteWaveSummary[];
}

export type ExecuteProgressTone = "accent" | "success" | "warning" | "dim";

export interface ExecuteProgressWidgetEntry {
  headline: string;
  blockLabel: string;
  metadata: string[];
  detail: string | null;
  tone: ExecuteProgressTone;
}

export interface ExecuteProgressHistoryEntry {
  status: string;
  entry?: ExecuteProgressWidgetEntry;
}

export interface ExecuteLiveProgressUpdate {
  wave: number;
  item: string;
  event: MapTaskProgressEvent;
}

export interface ExecuteWaveItemCompletionUpdate {
  wave: number;
  index?: number;
  jobId?: string;
  item: string;
  result?: MapResultRecord;
  isError: boolean;
  followUpCount: number;
}

export type ExecuteRuntime = Awaited<ReturnType<typeof ensureRuntime>>;

export type ExecuteRunWave = (
  ctx: ExtensionCommandContext,
  runtime: ExecuteRuntime,
  items: string[],
  wave: number,
  onProgress?: (update: ExecuteLiveProgressUpdate) => void,
  onItemComplete?: (
    update: ExecuteWaveItemCompletionUpdate
  ) => void | Promise<void>
) => Promise<{ summary: ExecuteWaveSummary; results: MapResultRecord[] }>;

export interface ExecutePlanDependencies {
  ensureRuntime?: typeof ensureRuntime;
  runWave?: ExecuteRunWave;
  createTasksBridge?: (
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext
  ) => Promise<ExecuteTasksBridge | null>;
  createExecutionId?: () => string;
  digestPlanItems?: (
    input: ExecutePlanDigestInput,
    ctx: ExtensionCommandContext
  ) => Promise<string[]>;
}

export interface ExecuteErrorDetails {
  error: string;
}

export interface ExecuteRenderStyles {
  accent: (text: string) => string;
  dim: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
  error: (text: string) => string;
}

export interface ExecuteProgressRenderStyles {
  accent: (text: string) => string;
  dim: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
}
