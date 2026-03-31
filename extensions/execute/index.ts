import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Box, Text, matchesKey } from "@mariozechner/pi-tui";

import { ensureRuntime } from "../../../pi-lcm/src/runtime.ts";
import { buildMapTask, resolveMapAgent, runAgentTask, runLlmTask } from "../../../pi-lcm/src/map-runner.ts";
import type { MapTaskProgressEvent } from "../../../pi-lcm/src/map-runner.ts";
import type { MapResultRecord } from "../../../pi-lcm/src/types.ts";

const COMMAND_NAME = "execute";
const EXECUTE_AGENT = "execute-step";
const TASK_TEMPLATE = [
  "Assigned atomic repo task:",
  "{item}",
  "",
  "Batch position: {index}/{total}.",
  "Complete only this assigned task.",
].join("\n");
const MAX_WAVE_ITEMS = 25;
const MAX_WAVES = 10;
const DEFAULT_MAX_ATTEMPTS = 1;
const READ_ONLY_CONCURRENCY = 2;
const WRITE_HEAVY_CONCURRENCY = 1;
const EXECUTE_TASK_RPC_TIMEOUT_MS = 1_000;
const EXECUTE_TASK_SOURCE = "execute";
const EXECUTE_ROOT_SUBJECT = "Execute plan";
const EXECUTE_ROOT_ACTIVE_FORM = "Executing plan";
const RISKY_STEP_PATTERN = /\b(add|change|create|delete|edit|fix|implement|migrate|move|refactor|remove|rename|replace|update|write)\b/i;
const PLAN_REFERENCE_PREFIX = "@";
const FILE_BACKED_PLAN_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"]);
const EXECUTE_PROGRESS_WIDGET_HISTORY_LIMIT = 8;
const EXECUTE_PROGRESS_DETAIL_PREVIEW_LENGTH = 96;
const EXECUTE_PROGRESS_DETAIL_FULL_LENGTH = 4_000;
let executeWidgetCounter = 0;

export interface ExecuteStepResult {
  status: "done" | "blocked" | "needs_followup";
  summary: string;
  filesTouched: string[];
  validation: string[];
  followUps: string[];
  blockers: string[];
}

interface ExecuteTaskSnapshot {
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

interface ExecuteTaskUpdateResult {
  task?: ExecuteTaskSnapshot;
  changedFields: string[];
  warnings: string[];
}

interface ExecuteTaskCreateInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

interface ExecuteTaskUpdateInput {
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

interface ExecuteTasksBridge {
  isAvailable(): boolean;
  createTask(input: ExecuteTaskCreateInput): Promise<ExecuteTaskSnapshot | undefined>;
  updateTask(input: ExecuteTaskUpdateInput): Promise<ExecuteTaskUpdateResult | undefined>;
  setTaskActive(taskId: string, active: boolean): Promise<boolean>;
}

interface ExecuteRpcContextPayload {
  uiCtx: ExtensionCommandContext["ui"];
  sessionId: string;
}

interface ExecuteQueuedItem {
  item: string;
  taskId?: string;
  parentTaskId?: string;
}

interface ExecutePlanDigestInput {
  rawArgs: string;
  directive: string;
  sourceText: string;
  sourceLabel: string;
  fallbackItems: string[];
}

export interface ExecutePlanDependencies {
  ensureRuntime?: typeof ensureRuntime;
  runWave?: typeof runWave;
  createTasksBridge?: (
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext
  ) => Promise<ExecuteTasksBridge | null>;
  createExecutionId?: () => string;
  digestPlanItems?: (input: ExecutePlanDigestInput, ctx: ExtensionCommandContext) => Promise<string[]>;
}

interface ExecuteCompletedItem {
  item: string;
  status: ExecuteStepResult["status"];
  summary: string;
}

interface ExecuteBlockedItem {
  item: string;
  reason: string;
}

interface ExecuteStructuredResultSummary {
  completed: ExecuteCompletedItem | null;
  blocked: ExecuteBlockedItem | null;
  filesTouched: string[];
  validation: string[];
  followUps: string[];
}

interface ExecuteWaveSummary {
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

interface ExecuteWidgetWaveState {
  wave: number;
  totalItems: number;
  completedItems: number;
  errorCount: number;
  queuedFollowUps: number;
  activeItem?: string;
}

interface ExecuteProgressWidgetState {
  completedItems: number;
  blockedItems: number;
  remainingItems: number;
  activeWave?: ExecuteWidgetWaveState;
  waves: ExecuteWaveSummary[];
}

interface ExecuteLiveProgressUpdate {
  wave: number;
  item: string;
  event: MapTaskProgressEvent;
}

interface ExecuteWaveItemCompletionUpdate {
  wave: number;
  index?: number;
  jobId?: string;
  item: string;
  result?: MapResultRecord;
  isError: boolean;
  followUpCount: number;
}

const uniqueStrings = (values: string[]): string[] => [...new Set(values)];

const normalizePlanLine = (line: string): string =>
  line
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/, "")
    .trim();

const isMarkdownPlanListLine = (line: string): boolean =>
  /^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/.test(line);

const isLikelyPlanFilePath = (input: string): boolean => {
  if (!input || /\r|\n/.test(input)) {
    return false;
  }

  const normalized = input.trim();
  if (!normalized || normalized.includes(";")) {
    return false;
  }

  return FILE_BACKED_PLAN_EXTENSIONS.has(path.extname(normalized).toLowerCase());
};

const EMBEDDED_PLAN_REFERENCE_PATTERN = /(?:^|\s)@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s]+))/;

const normalizeExecutePlanItems = (items: string[]): string[] =>
  uniqueStrings(
    items
      .flatMap((item) => parsePlanItems(item))
      .map((item) => item.trim())
      .filter(Boolean)
  );

const extractEmbeddedPlanReference = (input: string): { reference: string; remainingArgs: string } | null => {
  const match = input.match(EMBEDDED_PLAN_REFERENCE_PATTERN);
  if (!match || match.index == null) {
    return null;
  }

  const reference = match[1] ?? match[2] ?? match[3];
  if (!reference) {
    return null;
  }

  const before = input.slice(0, match.index).trim();
  const after = input.slice(match.index + match[0].length).trim();
  return {
    reference: reference.trim(),
    remainingArgs: [before, after].filter(Boolean).join(" ").trim(),
  };
};

const looksLikeEmbeddedPlanReference = (reference: string): boolean =>
  isLikelyPlanFilePath(reference) || /[\\/]/.test(reference);

export const parsePlanItems = (input: string): string[] => {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const lineItems = trimmed
    .split(/\r?\n/)
    .map((line) => normalizePlanLine(line))
    .filter(Boolean);

  if (lineItems.length > 1) {
    return lineItems;
  }

  const singleItem = normalizePlanLine(trimmed);
  if (!singleItem) return [];

  if (singleItem.includes(";")) {
    return singleItem
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [singleItem];
};

export const parsePlanDocumentItems = (input: string): string[] => {
  const listItems = input
    .split(/\r?\n/)
    .filter((line) => isMarkdownPlanListLine(line))
    .map((line) => normalizePlanLine(line))
    .filter(Boolean);

  if (listItems.length > 0) {
    return listItems;
  }

  return parsePlanItems(input);
};

const resolveExecutePlanReference = (
  reference: string,
  cwd: string,
  explicitReference: boolean,
  remainingArgs = ""
): { filePath: string; displayPath: string; explicitReference: boolean; remainingArgs: string } => ({
  filePath: path.isAbsolute(reference) ? reference : path.resolve(cwd, reference),
  displayPath: reference,
  explicitReference,
  remainingArgs,
});

const resolveExecutePlanPath = (
  input: string,
  cwd: string
): { filePath: string; displayPath: string; explicitReference: boolean; remainingArgs: string } | null => {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith(PLAN_REFERENCE_PREFIX)) {
    const reference = trimmed.slice(PLAN_REFERENCE_PREFIX.length).trim();
    if (!reference) {
      return null;
    }

    return resolveExecutePlanReference(reference, cwd, true);
  }

  const embeddedReference = extractEmbeddedPlanReference(trimmed);
  if (embeddedReference && looksLikeEmbeddedPlanReference(embeddedReference.reference)) {
    return resolveExecutePlanReference(embeddedReference.reference, cwd, true, embeddedReference.remainingArgs);
  }

  if (!isLikelyPlanFilePath(trimmed)) {
    return null;
  }

  return resolveExecutePlanReference(trimmed, cwd, false);
};

const readReferencedPlanSource = async (
  input: string,
  cwd: string
): Promise<{ sourceText: string; sourceLabel: string; directive: string } | null> => {
  const resolvedPath = resolveExecutePlanPath(input, cwd);
  if (!resolvedPath) {
    return null;
  }

  try {
    const sourceText = await readFile(resolvedPath.filePath, "utf8");
    return {
      sourceText,
      sourceLabel: resolvedPath.displayPath,
      directive: resolvedPath.remainingArgs,
    };
  } catch (error) {
    if (!resolvedPath.explicitReference) {
      return null;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read plan file ${resolvedPath.displayPath}: ${message}`);
  }
};

const resolveExecutePlanInput = async (
  input: string,
  cwd: string
): Promise<{ planItems: string[]; digestInput: ExecutePlanDigestInput | null }> => {
  const referencedPlan = await readReferencedPlanSource(input, cwd);
  if (referencedPlan) {
    const fallbackItems = parsePlanDocumentItems(referencedPlan.sourceText);
    return {
      planItems: fallbackItems,
      digestInput: {
        rawArgs: input,
        directive: referencedPlan.directive,
        sourceText: referencedPlan.sourceText,
        sourceLabel: referencedPlan.sourceLabel,
        fallbackItems,
      },
    };
  }

  return {
    planItems: parsePlanItems(input),
    digestInput: null,
  };
};

export const chooseWaveConcurrency = (items: string[]): number =>
  items.some((item) => RISKY_STEP_PATTERN.test(item)) ? WRITE_HEAVY_CONCURRENCY : READ_ONLY_CONCURRENCY;

export const buildExecuteWorkerTask = (item: string, index: number, total: number): string =>
  buildMapTask(TASK_TEMPLATE, item, index, total);

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

const stripJsonCodeFence = (value: string): string => {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
};

const buildExecutePlanDigestTask = (input: ExecutePlanDigestInput): string => {
  const extractedItems =
    input.fallbackItems.length > 0
      ? input.fallbackItems.map((item) => `- ${item}`).join("\n")
      : "- none extracted";

  return [
    "Rewrite this implementation plan into an ordered list of atomic repo tasks for /execute.",
    'Return JSON only in this exact shape: {"items":["task 1","task 2"]}',
    "Rules:",
    "- Break broad bullets or phases into concrete executable tasks.",
    "- Each item must be a single repo task a worker can complete in one focused pass.",
    "- Preserve execution order and dependencies.",
    "- Use concise imperative phrasing.",
    "- Omit headings, milestones, and parent-orchestrator meta steps.",
    "- Keep already-atomic tasks mostly unchanged.",
    input.directive ? `User directive: ${input.directive}` : "User directive: execute the plan.",
    `Plan source: ${input.sourceLabel}`,
    `Initially extracted items:\n${extractedItems}`,
    `Full plan:\n${input.sourceText.trim()}`,
  ].join("\n\n");
};

const parseExecutePlanDigestResult = (outputText: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonCodeFence(outputText));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Plan digester returned invalid JSON: ${message}`);
  }

  const items =
    Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? (parsed as { items?: unknown }).items
        : undefined;

  if (!Array.isArray(items)) {
    throw new Error("Plan digester result is missing items[]");
  }

  if (!items.every((item) => typeof item === "string")) {
    throw new Error("Plan digester items[] must contain only strings");
  }

  return normalizeExecutePlanItems(items);
};

const digestExecutePlanItems = async (
  input: ExecutePlanDigestInput,
  ctx: ExtensionCommandContext
): Promise<string[]> => {
  const result = await runLlmTask({
    cwd: ctx.cwd,
    task: buildExecutePlanDigestTask(input),
  });

  if (result.isError) {
    throw new Error(result.errorMessage ?? result.stderr.trim() ?? "Plan digester failed");
  }

  return parseExecutePlanDigestResult(result.outputText);
};

export const parseWorkerResult = (outputText: string): ExecuteStepResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonCodeFence(outputText));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Worker returned invalid JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Worker returned a non-object JSON value");
  }

  const result = parsed as Partial<ExecuteStepResult>;
  if (result.status !== "done" && result.status !== "blocked" && result.status !== "needs_followup") {
    throw new Error("Worker result is missing a valid status");
  }
  if (typeof result.summary !== "string") {
    throw new Error("Worker result is missing a string summary");
  }
  if (!isStringArray(result.filesTouched)) {
    throw new Error("Worker result is missing filesTouched[]");
  }
  if (!isStringArray(result.validation)) {
    throw new Error("Worker result is missing validation[]");
  }
  if (!isStringArray(result.followUps)) {
    throw new Error("Worker result is missing followUps[]");
  }
  if (!isStringArray(result.blockers)) {
    throw new Error("Worker result is missing blockers[]");
  }

  return {
    status: result.status,
    summary: result.summary,
    filesTouched: result.filesTouched,
    validation: result.validation,
    followUps: result.followUps,
    blockers: result.blockers,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

type ExecuteRpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

const executeRpcCall = <T>(
  pi: ExtensionAPI,
  channel: string,
  params: Record<string, unknown>,
  timeoutMs = EXECUTE_TASK_RPC_TIMEOUT_MS
): Promise<T> => {
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`${channel} timeout`));
    }, timeoutMs);
    const unsubscribe = pi.events.on(`${channel}:reply:${requestId}`, (raw: unknown) => {
      unsubscribe();
      clearTimeout(timer);
      const reply = raw as ExecuteRpcReply<T>;
      if (reply.success) {
        resolve(reply.data as T);
        return;
      }
      reject(new Error(reply.error));
    });
    pi.events.emit(channel, { requestId, ...params });
  });
};

const buildExecuteMetadata = (
  executionId: string,
  metadata?: Record<string, unknown>
): Record<string, unknown> => ({
  source: EXECUTE_TASK_SOURCE,
  executionId,
  ...metadata,
});

const buildExecuteItemActiveForm = (item: string): string => `Executing: ${item}`;

const buildExecuteItemDescription = (item: string, index: number, total: number): string =>
  [`Plan item ${index + 1}/${total}`, "", item].join("\n");

const buildFollowUpDescription = (item: string, parentItem: string): string =>
  ["Follow-up work discovered during /execute", "", item, "", `Parent item: ${parentItem}`].join("\n");

const buildBlockerDescription = (item: string, reason: string): string =>
  [`Blocked while executing: ${item}`, "", reason].join("\n");

const buildRemainingFollowUpsDescription = (count: number): string =>
  `Stopped after ${MAX_WAVES} waves with ${count} item(s) still queued`;

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
  const fieldPattern = /"(text|error|message|stderr)"\s*:\s*"((?:\\.|[^"\\])*)/g;

  for (const match of value.matchAll(fieldPattern)) {
    const fragment = match[2];
    if (!fragment) continue;
    const decoded = decodeExecuteJsonishString(fragment).replace(/\s+/g, " ").trim();
    if (decoded) {
      matches.push(decoded);
    }
  }

  return matches;
};

const formatExecuteToolDetail = (toolName: string | undefined, detail: string, maxLength: number): string => {
  const flattened = detail.replace(/\s+/g, " ").trim();
  if (!flattened) {
    return "";
  }

  switch (toolName) {
    case "bash":
    case "read":
    case "grep":
      return truncateInline(flattened, maxLength);
    case "edit":
    case "write":
      return truncateInline(flattened, Math.min(maxLength, 56));
    default:
      return truncateInline(flattened, maxLength);
  }
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
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      parsed = JSON.parse(trimmed);
      parsedStructuredValue = true;
    } catch {
      parsed = trimmed;
    }
  }

  const structuredText = parsedStructuredValue ? collectExecuteProgressText(parsed) : [];
  const extracted = structuredText
    .concat(collectExecuteJsonishFields(trimmed))
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (extracted.length > 0) {
    return formatExecuteToolDetail(toolName, extracted[0] ?? "", maxLength);
  }

  if (parsedStructuredValue || looksStructured || /"content"\s*:\s*\[\s*\]/.test(trimmed)) {
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
  const itemLabel = truncateInline(item, options.itemMaxLength ?? 56);
  const detailMaxLength = options.detailMaxLength ?? 72;

  switch (event.type) {
    case "assistant_text":
      return `Wave ${wave}: ${itemLabel} — thinking…`;
    case "tool_start":
      return `Wave ${wave}: ${itemLabel} — ${event.toolName}…`;
    case "tool_update": {
      const detail = formatExecuteProgressDetail(event.toolName, event.text, detailMaxLength);
      return `Wave ${wave}: ${itemLabel} — ${event.toolName}${detail ? `: ${detail}` : ""}`;
    }
    case "tool_end": {
      const outcome = event.isError ? "error" : "done";
      const detail = formatExecuteProgressDetail(event.toolName, event.text, detailMaxLength);
      return `Wave ${wave}: ${itemLabel} — ${event.toolName} ${outcome}${detail ? `: ${detail}` : ""}`;
    }
  }
};

const buildExecuteWidgetPreview = (planItems: string[]): string => {
  if (planItems.length === 0) {
    return "waiting for plan items";
  }

  if (planItems.length === 1) {
    return truncateInline(planItems[0] ?? "", 72);
  }

  return `${planItems.length} items — ${truncateInline(planItems[0] ?? "", 48)}`;
};

interface ExecuteProgressRenderStyles {
  accent: (text: string) => string;
  dim: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
}

const defaultExecuteProgressRenderStyles: ExecuteProgressRenderStyles = {
  accent: (text) => text,
  dim: (text) => text,
  success: (text) => text,
  warning: (text) => text,
};

const buildExecuteProgressBar = (completedItems: number, totalItems: number, width = 10): string => {
  if (totalItems <= 0) {
    return `[${"░".repeat(width)}]`;
  }

  const ratio = Math.max(0, Math.min(1, completedItems / totalItems));
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `[${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}]`;
};

const formatExecuteWidgetWaveLine = (
  wave: Pick<ExecuteWidgetWaveState, "wave" | "totalItems" | "completedItems" | "errorCount" | "queuedFollowUps">,
  styles: ExecuteProgressRenderStyles,
  active = false
): string => {
  const status = active ? styles.accent("running") : wave.errorCount > 0 ? styles.warning(`${wave.errorCount} errors`) : styles.success("ok");
  const followUps = wave.queuedFollowUps > 0 ? `${wave.queuedFollowUps} follow-ups` : "no follow-ups";
  return `${styles.dim("•")} Wave ${wave.wave}  ${buildExecuteProgressBar(wave.completedItems, wave.totalItems)}  ${wave.completedItems}/${wave.totalItems} done  ${status}  ${styles.dim(followUps)}`;
};

const splitExecuteCurrentStatus = (currentStatus: string): { headline: string; detail: string | null } => {
  const trimmed = currentStatus.trim();
  const separatorIndex = trimmed.indexOf(" — ");
  if (separatorIndex === -1) {
    return { headline: trimmed, detail: null };
  }

  return {
    headline: trimmed.slice(0, separatorIndex).trim(),
    detail: trimmed.slice(separatorIndex + 3).trim() || null,
  };
};

const isExecuteCurrentStatusExpandable = (currentStatus: string): boolean => {
  const { detail } = splitExecuteCurrentStatus(currentStatus);
  return Boolean(detail && detail.length > EXECUTE_PROGRESS_DETAIL_PREVIEW_LENGTH);
};

const appendExecuteCurrentStatusLines = (
  lines: string[],
  currentStatus: string,
  expanded: boolean,
  styles: ExecuteProgressRenderStyles
): void => {
  const current = currentStatus.trim();
  if (!current) {
    return;
  }

  const { headline, detail } = splitExecuteCurrentStatus(current);
  const expandable = isExecuteCurrentStatusExpandable(current);
  const detailText = detail
    ? expandable && !expanded
      ? truncateInline(detail, EXECUTE_PROGRESS_DETAIL_PREVIEW_LENGTH)
      : detail
    : null;

  lines.push("", styles.accent("Current"), `${styles.dim("•")} ${headline}`);

  if (detailText) {
    lines.push(`${styles.dim("↳")} ${detailText}`);
  }

  if (expandable) {
    lines.push(styles.dim(expanded ? "ctrl+o collapse current detail" : "ctrl+o expand current detail"));
  }
};

export const buildExecuteProgressWidgetRenderText = (
  planItems: string[],
  currentStatus: string,
  history: string[],
  progress?: ExecuteProgressWidgetState,
  styles: ExecuteProgressRenderStyles = defaultExecuteProgressRenderStyles,
  expandedCurrentStatus = false
): string => {
  const lines = [styles.accent("/execute"), styles.dim(buildExecuteWidgetPreview(planItems))];

  if (progress) {
    const totalItems = progress.completedItems + progress.blockedItems + progress.remainingItems;
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
          lines.push(`  ${styles.dim("active:")} ${truncateInline(progress.activeWave.activeItem, 72)}`);
        }
      }
    }
  }

  const current = currentStatus.trim();
  appendExecuteCurrentStatusLines(lines, currentStatus, expandedCurrentStatus, styles);

  const normalizedHistory = history.map((entry) => entry.trim()).filter(Boolean);
  const historyWithoutCurrent =
    current && normalizedHistory.at(-1) === current ? normalizedHistory.slice(0, -1) : normalizedHistory;
  const visibleHistory = historyWithoutCurrent.slice(-EXECUTE_PROGRESS_WIDGET_HISTORY_LIMIT);
  const skipped = historyWithoutCurrent.length - visibleHistory.length;

  if (visibleHistory.length > 0) {
    lines.push("", styles.accent("Recent"));
    if (skipped > 0) {
      lines.push(styles.dim(`… ${skipped} earlier updates`));
    }
    for (const entry of visibleHistory) {
      lines.push(`${styles.dim("•")} ${entry}`);
    }
  }

  return lines.join("\n");
};

export const buildExecuteProgressWidgetLines = (
  planItems: string[],
  currentStatus: string,
  history: string[],
  progress?: ExecuteProgressWidgetState,
  expandedCurrentStatus = false
): string[] =>
  buildExecuteProgressWidgetRenderText(planItems, currentStatus, history, progress, undefined, expandedCurrentStatus).split("\n");

class ExecuteProgressWidgetBody {
  private readonly text = new Text();

  constructor(
    private readonly planItems: string[],
    private readonly currentStatus: string,
    private readonly history: string[],
    private readonly progress: ExecuteProgressWidgetState | undefined,
    private readonly styles: ExecuteProgressRenderStyles,
    private readonly expandedCurrentStatus: boolean
  ) {}

  render(width: number): string[] {
    this.text.setText(
      buildExecuteProgressWidgetRenderText(
        this.planItems,
        this.currentStatus,
        this.history,
        this.progress,
        this.styles,
        this.expandedCurrentStatus
      )
    );
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

const updateExecuteProgressWidget = (
  ctx: ExtensionCommandContext,
  widgetKey: string,
  planItems: string[],
  currentStatus: string,
  history: string[],
  progress?: ExecuteProgressWidgetState,
  expandedCurrentStatus = false
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
        expandedCurrentStatus
      ),
    {
      placement: "aboveEditor",
    }
  );
};

export const createExecuteTasksBridge = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext
): Promise<ExecuteTasksBridge | null> => {
  const rpcContext: ExecuteRpcContextPayload = {
    uiCtx: ctx.ui,
    sessionId: ctx.sessionManager.getSessionId(),
  };
  const withRpcContext = (params: Record<string, unknown>): Record<string, unknown> => ({
    ...params,
    ...rpcContext,
  });

  try {
    await executeRpcCall<{ version?: string | number }>(pi, "tasks:rpc:ping", withRpcContext({}));
  } catch {
    return null;
  }

  const callIfAvailable = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };

  return {
    isAvailable: () => true,
    createTask: async (input) =>
      await callIfAvailable(() => executeRpcCall<ExecuteTaskSnapshot>(pi, "tasks:rpc:create", withRpcContext(input))),
    updateTask: async (input) =>
      await callIfAvailable(() => executeRpcCall<ExecuteTaskUpdateResult>(pi, "tasks:rpc:update", withRpcContext(input))),
    setTaskActive: async (taskId, active) => {
      const result = await callIfAvailable(() =>
        executeRpcCall<{ taskId: string; active: boolean }>(
          pi,
          "tasks:rpc:set-active",
          withRpcContext({ taskId, active })
        )
      );
      return Boolean(result?.taskId);
    },
  };
};

const buildSummaryMessage = (details: ExecuteSummaryDetails): string => {
  const lines = [
    "## /execute summary",
    "",
    `- Initial plan items: ${details.planItems.length}`,
    `- Waves executed: ${details.waves.length}`,
    `- Completed items: ${details.completed.length}`,
    `- Blocked items: ${details.blocked.length}`,
    `- Files touched: ${details.filesTouched.length}`,
    `- Validation steps: ${details.validation.length}`,
  ];

  if (details.waves.length > 0) {
    lines.push("", "### Waves");
    for (const wave of details.waves) {
      lines.push(
        `- Wave ${wave.wave}: ${wave.jobId} — ${wave.totalItems} items, ${wave.completedItems} completed, ${wave.errorCount} errors, ${wave.queuedFollowUps} follow-ups`
      );
    }
  }

  if (details.completed.length > 0) {
    lines.push("", "### Completed items");
    for (const item of details.completed) {
      lines.push(`- ${item.item} — ${item.summary}`);
    }
  }

  if (details.blocked.length > 0) {
    lines.push("", "### Blocked items");
    for (const item of details.blocked) {
      lines.push(`- ${item.item} — ${item.reason}`);
    }
  }

  if (details.filesTouched.length > 0) {
    lines.push("", "### Files touched");
    for (const file of details.filesTouched) {
      lines.push(`- ${file}`);
    }
  }

  if (details.validation.length > 0) {
    lines.push("", "### Validation");
    for (const check of details.validation) {
      lines.push(`- ${check}`);
    }
  }

  if (details.remainingFollowUps.length > 0) {
    lines.push("", "### Remaining follow-ups");
    for (const followUp of details.remainingFollowUps) {
      lines.push(`- ${followUp}`);
    }
  }

  return lines.join("\n");
};

const appendWaveResult = async (
  store: {
    appendMapResult: (input: {
      jobId: string;
      index: number;
      item: string;
      task: string;
      attemptCount: number;
      outputText: string;
      structuredOutput?: unknown;
      isError: boolean;
      stderr: string;
      exitCode: number;
      model: string | null;
      stopReason: string | null;
      errorMessage: string | null;
    }) => Promise<MapResultRecord>;
  },
  params: {
    jobId: string;
    index: number;
    item: string;
    task: string;
    outputText: string;
    stderr: string;
    exitCode: number;
    model: string | null;
    stopReason: string | null;
    errorMessage: string | null;
  }
): Promise<MapResultRecord> => {
  try {
    const structuredOutput = parseWorkerResult(params.outputText);
    return store.appendMapResult({
      ...params,
      attemptCount: DEFAULT_MAX_ATTEMPTS,
      structuredOutput,
      isError: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return store.appendMapResult({
      ...params,
      attemptCount: DEFAULT_MAX_ATTEMPTS,
      isError: true,
      errorMessage: params.errorMessage ?? message,
    });
  }
};

const runWave = async (
  ctx: ExtensionCommandContext,
  runtime: Awaited<ReturnType<typeof ensureRuntime>>,
  items: string[],
  wave: number,
  onProgress?: (update: ExecuteLiveProgressUpdate) => void,
  onItemComplete?: (update: ExecuteWaveItemCompletionUpdate) => void | Promise<void>
): Promise<{ summary: ExecuteWaveSummary; results: MapResultRecord[] }> => {
  const maxConcurrency = Math.min(chooseWaveConcurrency(items), items.length);
  const agent = resolveMapAgent(ctx.cwd, EXECUTE_AGENT, "both");
  const job = await runtime.store.createMapJob({
    kind: "agentic_map",
    agentName: agent.name,
    agentSource: agent.source,
    requestedModel: agent.model ?? null,
    taskTemplate: TASK_TEMPLATE,
    items,
    maxConcurrency,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  });

  const results: MapResultRecord[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (!item) return;

      const task = buildExecuteWorkerTask(item, index, items.length);
      const execution = await runAgentTask({
        cwd: ctx.cwd,
        agent,
        task,
        onProgress: (event) => {
          onProgress?.({ wave, item, event });
        },
      });

      const result = await appendWaveResult(runtime.store, {
        jobId: job.publicId,
        index,
        item,
        task,
        outputText: execution.outputText,
        stderr: execution.stderr,
        exitCode: execution.exitCode,
        model: execution.model,
        stopReason: execution.stopReason,
        errorMessage: execution.errorMessage,
      });

      const followUps =
        result.structuredOutput && typeof result.structuredOutput === "object"
          ? (result.structuredOutput as Partial<ExecuteStepResult>).followUps
          : undefined;
      await onItemComplete?.({
        wave,
        index,
        jobId: job.publicId,
        item,
        result,
        isError: result.isError,
        followUpCount: Array.isArray(followUps) ? followUps.length : 0,
      });

      results[index] = result;
    }
  };

  await Promise.all(Array.from({ length: maxConcurrency }, async () => worker()));
  const completedJob = await runtime.store.completeMapJob(job.publicId, "completed");
  const queuedFollowUps = results.reduce((count, result) => {
    if (!result?.structuredOutput || typeof result.structuredOutput !== "object") {
      return count;
    }
    const followUps = (result.structuredOutput as Partial<ExecuteStepResult>).followUps;
    return count + (Array.isArray(followUps) ? followUps.length : 0);
  }, 0);

  const orderedResults = items.map((item, index) => {
    const result = results[index];
    if (!result) {
      throw new Error(`Wave ${wave} missing result for item ${index + 1}: ${item}`);
    }
    return result;
  });

  return {
    summary: {
      wave,
      jobId: completedJob.publicId,
      totalItems: items.length,
      completedItems: completedJob.completedItems,
      errorCount: completedJob.errorCount,
      queuedFollowUps,
    },
    results: orderedResults,
  };
};

interface ExecuteErrorDetails {
  error: string;
}

const isExecuteErrorDetails = (value: unknown): value is ExecuteErrorDetails =>
  Boolean(value) && typeof value === "object" && typeof (value as { error?: unknown }).error === "string";

const isExecuteSummaryDetails = (value: unknown): value is ExecuteSummaryDetails =>
  Boolean(value) &&
  typeof value === "object" &&
  Array.isArray((value as { planItems?: unknown }).planItems) &&
  Array.isArray((value as { waves?: unknown }).waves) &&
  Array.isArray((value as { completed?: unknown }).completed) &&
  Array.isArray((value as { blocked?: unknown }).blocked) &&
  Array.isArray((value as { filesTouched?: unknown }).filesTouched) &&
  Array.isArray((value as { validation?: unknown }).validation) &&
  Array.isArray((value as { remainingFollowUps?: unknown }).remainingFollowUps);

interface ExecuteRenderStyles {
  accent: (text: string) => string;
  dim: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
  error: (text: string) => string;
}

const sendExecuteSummaryMessage = (pi: ExtensionAPI, content: string, details: unknown): void => {
  pi.sendMessage(
    {
      customType: "execute-summary",
      content,
      display: true,
      details,
    },
    { triggerTurn: false }
  );
};

const defaultRenderStyles: ExecuteRenderStyles = {
  accent: (text) => text,
  dim: (text) => text,
  success: (text) => text,
  warning: (text) => text,
  error: (text) => text,
};

const truncateInline = (value: string, maxLength: number): string => {
  const flattened = value.replace(/\s+/g, " ").trim();
  if (flattened.length <= maxLength) {
    return flattened;
  }
  return `${flattened.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

export const buildExecuteSummaryRenderText = (
  details: ExecuteSummaryDetails | ExecuteErrorDetails,
  expanded: boolean,
  styles: ExecuteRenderStyles = defaultRenderStyles,
  compactWidth = 140
): string => {
  if (isExecuteErrorDetails(details)) {
    return [styles.error("/execute failed"), `${styles.error("!")} ${details.error}`].join("\n");
  }

  const lines = [
    styles.accent("/execute"),
    `Plan ${details.planItems.length}  Waves ${details.waves.length}  ${styles.success(`Done ${details.completed.length}`)}  ${styles.warning(`Blocked ${details.blocked.length}`)}`,
    styles.dim(`Files ${details.filesTouched.length}  Validation ${details.validation.length}`),
  ];
  const compactLineWidth = Math.max(72, compactWidth);

  const visibleWaves = expanded ? details.waves : details.waves.slice(0, 3);
  if (visibleWaves.length > 0) {
    lines.push("", styles.accent("Waves"));
    for (const wave of visibleWaves) {
      const statusLabel = wave.errorCount > 0 ? styles.warning(`${wave.errorCount} errors`) : styles.success("ok");
      const jobLabel = expanded ? `  ${styles.dim(wave.jobId)}` : "";
      lines.push(
        `${styles.dim("•")} Wave ${wave.wave}${jobLabel}  ${wave.completedItems}/${wave.totalItems} done  ${statusLabel}  ${styles.dim(`${wave.queuedFollowUps} follow-ups`)}`
      );
    }
    if (!expanded && details.waves.length > visibleWaves.length) {
      lines.push(styles.dim(`… ${details.waves.length - visibleWaves.length} more wave(s)`));
    }
  }

  const visibleCompleted = expanded ? details.completed : details.completed.slice(0, 3);
  if (visibleCompleted.length > 0) {
    lines.push("", styles.accent("Completed"));
    for (const item of visibleCompleted) {
      if (expanded) {
        lines.push(`${styles.success("✓")} ${item.item}`);
        lines.push(`  ${item.summary}`);
      } else {
        lines.push(`${styles.success("✓")} ${truncateInline(`${item.item} — ${item.summary}`, compactLineWidth)}`);
      }
    }
    if (!expanded && details.completed.length > visibleCompleted.length) {
      lines.push(styles.dim(`… ${details.completed.length - visibleCompleted.length} more completed item(s)`));
    }
  }

  const visibleBlocked = expanded ? details.blocked : details.blocked.slice(0, 3);
  if (visibleBlocked.length > 0) {
    lines.push("", styles.accent("Blocked"));
    for (const item of visibleBlocked) {
      if (expanded) {
        lines.push(`${styles.warning("!")} ${item.item}`);
        lines.push(`  ${item.reason}`);
      } else {
        lines.push(`${styles.warning("!")} ${truncateInline(`${item.item} — ${item.reason}`, compactLineWidth)}`);
      }
    }
    if (!expanded && details.blocked.length > visibleBlocked.length) {
      lines.push(styles.dim(`… ${details.blocked.length - visibleBlocked.length} more blocked item(s)`));
    }
  }

  if (expanded && details.filesTouched.length > 0) {
    lines.push("", styles.accent("Files touched"));
    for (const file of details.filesTouched) {
      lines.push(`${styles.dim("•")} ${file}`);
    }
  }

  if (details.validation.length > 0) {
    lines.push("", styles.accent("Validation"));
    for (const check of expanded ? details.validation : details.validation.slice(0, 5)) {
      lines.push(`${styles.dim("•")} ${truncateInline(check, expanded ? 400 : compactLineWidth)}`);
    }
    if (!expanded && details.validation.length > 5) {
      lines.push(styles.dim(`… ${details.validation.length - 5} more validation step(s)`));
    }
  }

  if (details.remainingFollowUps.length > 0) {
    lines.push("", styles.accent("Remaining follow-ups"));
    for (const followUp of expanded ? details.remainingFollowUps : details.remainingFollowUps.slice(0, 5)) {
      lines.push(`${styles.dim("→")} ${truncateInline(followUp, expanded ? 400 : compactLineWidth)}`);
    }
    if (!expanded && details.remainingFollowUps.length > 5) {
      lines.push(styles.dim(`… ${details.remainingFollowUps.length - 5} more follow-up(s)`));
    }
  }

  if (!expanded) {
    const hasHiddenDetails =
      details.waves.length > visibleWaves.length ||
      details.completed.length > visibleCompleted.length ||
      details.blocked.length > visibleBlocked.length ||
      details.filesTouched.length > 0 ||
      details.remainingFollowUps.length > 0 ||
      details.validation.length > 5;
    if (hasHiddenDetails) {
      lines.push("", styles.dim("↵ expand for job ids, full summaries, files, and follow-ups"));
    }
  }

  return lines.join("\n");
};

const buildBlockedReason = (result: ExecuteStepResult): string => {
  const blockers = uniqueStrings(result.blockers.map((entry) => entry.trim()).filter(Boolean));
  return blockers.length > 0 ? blockers.join("; ") : result.summary;
};

export const summarizeExecuteStructuredResult = (
  item: string,
  result: ExecuteStepResult
): ExecuteStructuredResultSummary => {
  const filesTouched = result.filesTouched.map((entry) => entry.trim()).filter(Boolean);
  const validation = result.validation.map((entry) => entry.trim()).filter(Boolean);

  if (result.status === "blocked") {
    return {
      completed: null,
      blocked: {
        item,
        reason: buildBlockedReason(result),
      },
      filesTouched,
      validation,
      followUps: [],
    };
  }

  return {
    completed: {
      item,
      status: result.status,
      summary: result.summary,
    },
    blocked: null,
    filesTouched,
    validation,
    followUps: result.followUps.map((entry) => entry.trim()).filter(Boolean),
  };
};

export const executePlan = async (
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: ExecutePlanDependencies = {}
): Promise<void> => {
  let planItems: string[];
  let digestInput: ExecutePlanDigestInput | null;
  try {
    const resolvedPlan = await resolveExecutePlanInput(args, ctx.cwd);
    planItems = resolvedPlan.planItems;
    digestInput = resolvedPlan.digestInput;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message, "warning");
    return;
  }

  const widgetKey = `execute-${++executeWidgetCounter}`;
  const progressHistory: string[] = [];
  let currentStatus = "";
  let currentStatusForWidget = "";
  let expandedCurrentStatus = false;
  const progressState: ExecuteProgressWidgetState = {
    completedItems: 0,
    blockedItems: 0,
    remainingItems: planItems.length,
    waves: [],
  };

  const refreshProgressWidget = (): void => {
    updateExecuteProgressWidget(
      ctx,
      widgetKey,
      planItems,
      currentStatusForWidget || currentStatus,
      progressHistory,
      progressState,
      expandedCurrentStatus
    );
  };

  const recordProgress = (status: string, widgetStatus = status): void => {
    currentStatus = status;
    currentStatusForWidget = widgetStatus;
    progressHistory.push(status);
    refreshProgressWidget();
    ctx.ui.setStatus(COMMAND_NAME, status);
  };

  const removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
    if (
      !(matchesKey(data, "ctrl+o") || data === "\u000f") ||
      !isExecuteCurrentStatusExpandable(currentStatusForWidget || currentStatus)
    ) {
      return undefined;
    }

    expandedCurrentStatus = !expandedCurrentStatus;
    refreshProgressWidget();
    return { consume: true };
  });

  const digestPlanItemsImpl = dependencies.digestPlanItems ?? digestExecutePlanItems;
  if (digestInput) {
    recordProgress(`Digesting ${digestInput.sourceLabel} into executable tasks...`);
    try {
      const digestedItems = await digestPlanItemsImpl(digestInput, ctx);
      if (digestedItems.length > 0) {
        planItems = digestedItems;
        progressState.remainingItems = planItems.length;
        recordProgress(`Prepared ${planItems.length} executable task(s)`);
      } else {
        ctx.ui.notify("Unable to digest plan, using parsed items: digester returned no tasks", "warning");
        recordProgress(`Using ${planItems.length} parsed plan item(s)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Unable to digest plan, using parsed items: ${message}`, "warning");
      recordProgress(`Using ${planItems.length} parsed plan item(s)`);
    }
  }

  if (planItems.length === 0) {
    ctx.ui.notify("Usage: /execute <plan>", "warning");
    ctx.ui.setWidget(widgetKey, undefined);
    ctx.ui.setStatus(COMMAND_NAME, "");
    return;
  }

  const ensureRuntimeImpl = dependencies.ensureRuntime ?? ensureRuntime;
  const runWaveImpl = dependencies.runWave ?? runWave;
  const createTasksBridgeImpl = dependencies.createTasksBridge ?? createExecuteTasksBridge;
  const executionId = (dependencies.createExecutionId ?? (() => `execute:${Date.now()}`))();

  let taskBridge: ExecuteTasksBridge | null = null;
  let rootTaskId: string | undefined;

  recordProgress(`Executing ${planItems.length} plan item(s)...`);

  try {
    const runtime = await ensureRuntimeImpl(ctx);
    resolveMapAgent(ctx.cwd, EXECUTE_AGENT, "both");
    taskBridge = await createTasksBridgeImpl(pi, ctx);
    if (!taskBridge) {
      ctx.ui.notify("/execute: pi-tasks bridge unavailable — load pi-tasks to see live task progress", "info");
    }

    const pendingItems: ExecuteQueuedItem[] = [];
    const seenFollowUps = new Set(planItems);
    const completed: ExecuteCompletedItem[] = [];
    const blocked: ExecuteBlockedItem[] = [];
    const filesTouched = new Set<string>();
    const validation = new Set<string>();
    const waves: ExecuteWaveSummary[] = [];
    const blockerTaskIds = new Set<string>();

    const createBridgeTask = async (input: ExecuteTaskCreateInput): Promise<string | undefined> => {
      if (!taskBridge?.isAvailable()) {
        return undefined;
      }
      const task = await taskBridge.createTask(input);
      return task?.id;
    };

    const createBlockerTask = async (
      item: string,
      reason: string,
      metadata?: Record<string, unknown>
    ): Promise<string | undefined> =>
      await createBridgeTask({
        subject: `Unblock: ${item}`,
        description: buildBlockerDescription(item, reason),
        metadata: buildExecuteMetadata(executionId, metadata),
      });

    if (taskBridge?.isAvailable()) {
      rootTaskId = await createBridgeTask({
        subject: EXECUTE_ROOT_SUBJECT,
        description: args.trim(),
        activeForm: EXECUTE_ROOT_ACTIVE_FORM,
        metadata: buildExecuteMetadata(executionId, { planCount: planItems.length }),
      });
      if (rootTaskId) {
        await taskBridge.updateTask({
          taskId: rootTaskId,
          status: "in_progress",
          owner: EXECUTE_TASK_SOURCE,
          metadata: buildExecuteMetadata(executionId, { planCount: planItems.length }),
        });
        await taskBridge.setTaskActive(rootTaskId, true);
      }
    }

    for (const [index, item] of planItems.entries()) {
      const taskId = await createBridgeTask({
        subject: item,
        description: buildExecuteItemDescription(item, index, planItems.length),
        activeForm: buildExecuteItemActiveForm(item),
        metadata: buildExecuteMetadata(executionId, {
          itemIndex: index,
          planItem: item,
          rootTaskId,
        }),
      });
      pendingItems.push({ item, taskId });
    }
    progressState.remainingItems = pendingItems.length;
    refreshProgressWidget();

    let waveNumber = 0;
    while (pendingItems.length > 0 && waveNumber < MAX_WAVES) {
      waveNumber += 1;
      const waveEntries = pendingItems.splice(0, MAX_WAVE_ITEMS);
      const waveItems = waveEntries.map((entry) => entry.item);
      progressState.activeWave = {
        wave: waveNumber,
        totalItems: waveItems.length,
        completedItems: 0,
        errorCount: 0,
        queuedFollowUps: 0,
      };
      progressState.remainingItems = pendingItems.length + waveItems.length;
      recordProgress(`Wave ${waveNumber}: ${waveItems.length} item(s)`);

      if (taskBridge?.isAvailable()) {
        for (const entry of waveEntries) {
          if (!entry.taskId) continue;
          await taskBridge.updateTask({
            taskId: entry.taskId,
            status: "in_progress",
            owner: EXECUTE_TASK_SOURCE,
            metadata: buildExecuteMetadata(executionId, {
              wave: waveNumber,
              planItem: entry.item,
              rootTaskId,
              parentTaskId: entry.parentTaskId,
            }),
          });
          await taskBridge.setTaskActive(entry.taskId, true);
        }
      }

      const { summary, results } = await runWaveImpl(
        ctx,
        runtime,
        waveItems,
        waveNumber,
        (update) => {
          if (progressState.activeWave?.wave === update.wave) {
            progressState.activeWave = {
              ...progressState.activeWave,
              activeItem: update.item,
            };
          }
          recordProgress(
            buildExecuteLiveStatus(update.wave, update.item, update.event),
            buildExecuteLiveStatus(update.wave, update.item, update.event, {
              itemMaxLength: 120,
              detailMaxLength: EXECUTE_PROGRESS_DETAIL_FULL_LENGTH,
            })
          );
        },
        async (update) => {
          // Mid-wave task sync is best-effort live UX only. The post-wave results loop below
          // remains the source of truth for follow-up creation, blocker linkage, and final
          // summary aggregation.
          if (
            typeof update.index === "number" &&
            update.jobId &&
            update.result &&
            taskBridge?.isAvailable()
          ) {
            const entry = waveEntries[update.index] ?? { item: update.item };
            if (entry.taskId) {
              const baseMetadata = buildExecuteMetadata(executionId, {
                wave: update.wave,
                jobId: update.jobId,
                planItem: update.item,
                rootTaskId,
                parentTaskId: entry.parentTaskId,
              });

              await taskBridge.setTaskActive(entry.taskId, false);
              if (update.result.isError) {
                const reason =
                  (update.result.errorMessage ?? update.result.stderr.trim()) ||
                  `Worker exited with code ${update.result.exitCode}`;
                await taskBridge.updateTask({
                  taskId: entry.taskId,
                  status: "pending",
                  metadata: {
                    ...baseMetadata,
                    resultStatus: "blocked",
                    blockerReason: reason,
                    summary: reason,
                  },
                });
              } else {
                const structured = update.result.structuredOutput as ExecuteStepResult;
                const resultSummary = summarizeExecuteStructuredResult(update.item, structured);
                await taskBridge.updateTask({
                  taskId: entry.taskId,
                  status: resultSummary.blocked ? "pending" : "completed",
                  metadata: {
                    ...baseMetadata,
                    resultStatus: structured.status,
                    blockerReason: resultSummary.blocked?.reason,
                    summary: structured.summary,
                    filesTouched: resultSummary.filesTouched,
                    validation: resultSummary.validation,
                  },
                });
              }
            }
          }

          if (progressState.activeWave?.wave !== update.wave) {
            return;
          }

          let completedDelta = 0;
          let blockedDelta = 0;
          if (update.result?.isError ?? update.isError) {
            blockedDelta = 1;
          } else if (update.result?.structuredOutput) {
            const structured = update.result.structuredOutput as ExecuteStepResult;
            const resultSummary = summarizeExecuteStructuredResult(update.item, structured);
            completedDelta = resultSummary.completed ? 1 : 0;
            blockedDelta = resultSummary.blocked ? 1 : 0;
          } else {
            completedDelta = 1;
          }

          const completedItems = progressState.activeWave.completedItems + 1;
          progressState.activeWave = {
            ...progressState.activeWave,
            activeItem: update.item,
            completedItems,
            errorCount: progressState.activeWave.errorCount + (update.isError ? 1 : 0),
            queuedFollowUps: progressState.activeWave.queuedFollowUps + update.followUpCount,
          };
          progressState.completedItems += completedDelta;
          progressState.blockedItems += blockedDelta;
          progressState.remainingItems = pendingItems.length + Math.max(0, waveItems.length - completedItems);
          refreshProgressWidget();
        }
      );
      waves.push(summary);

      if (rootTaskId && taskBridge?.isAvailable()) {
        await taskBridge.updateTask({
          taskId: rootTaskId,
          metadata: buildExecuteMetadata(executionId, {
            planCount: planItems.length,
            lastWave: waveNumber,
            lastJobId: summary.jobId,
          }),
        });
      }

      // Reconcile the full ordered wave results after all workers finish. This pass preserves
      // final summary aggregation and adds any blocker/follow-up bookkeeping that the mid-wave
      // fast path intentionally skips.
      for (const [index, result] of results.entries()) {
        const entry = waveEntries[index] ?? { item: result.item };
        const baseMetadata = buildExecuteMetadata(executionId, {
          wave: waveNumber,
          jobId: summary.jobId,
          planItem: result.item,
          rootTaskId,
          parentTaskId: entry.parentTaskId,
        });

        if (result.isError) {
          const reason =
            (result.errorMessage ?? result.stderr.trim()) || `Worker exited with code ${result.exitCode}`;
          blocked.push({ item: result.item, reason });

          if (entry.taskId && taskBridge?.isAvailable()) {
            await taskBridge.setTaskActive(entry.taskId, false);
            const blockerTaskId = await createBlockerTask(result.item, reason, {
              blockerForTaskId: entry.taskId,
              rootTaskId,
            });
            if (blockerTaskId) {
              blockerTaskIds.add(blockerTaskId);
            }
            await taskBridge.updateTask({
              taskId: entry.taskId,
              status: "pending",
              metadata: {
                ...baseMetadata,
                resultStatus: "blocked",
                blockerReason: reason,
                summary: reason,
              },
              addBlockedBy: blockerTaskId ? [blockerTaskId] : undefined,
            });
          }
          continue;
        }

        const structured = result.structuredOutput as ExecuteStepResult;
        const resultSummary = summarizeExecuteStructuredResult(result.item, structured);

        if (resultSummary.completed) {
          completed.push(resultSummary.completed);
        }
        if (resultSummary.blocked) {
          blocked.push(resultSummary.blocked);
        }

        for (const file of resultSummary.filesTouched) {
          filesTouched.add(file);
        }
        for (const check of resultSummary.validation) {
          validation.add(check);
        }

        if (entry.taskId && taskBridge?.isAvailable()) {
          await taskBridge.setTaskActive(entry.taskId, false);
          if (resultSummary.blocked) {
            const blockerTaskId = await createBlockerTask(result.item, resultSummary.blocked.reason, {
              blockerForTaskId: entry.taskId,
              rootTaskId,
            });
            if (blockerTaskId) {
              blockerTaskIds.add(blockerTaskId);
            }
            await taskBridge.updateTask({
              taskId: entry.taskId,
              status: "pending",
              metadata: {
                ...baseMetadata,
                resultStatus: structured.status,
                blockerReason: resultSummary.blocked.reason,
                summary: structured.summary,
                filesTouched: resultSummary.filesTouched,
                validation: resultSummary.validation,
              },
              addBlockedBy: blockerTaskId ? [blockerTaskId] : undefined,
            });
          } else {
            await taskBridge.updateTask({
              taskId: entry.taskId,
              status: "completed",
              metadata: {
                ...baseMetadata,
                resultStatus: structured.status,
                summary: structured.summary,
                filesTouched: resultSummary.filesTouched,
                validation: resultSummary.validation,
              },
            });
          }
        }

        for (const followUp of resultSummary.followUps) {
          if (seenFollowUps.has(followUp)) continue;
          seenFollowUps.add(followUp);
          const followUpTaskId = await createBridgeTask({
            subject: followUp,
            description: buildFollowUpDescription(followUp, result.item),
            activeForm: buildExecuteItemActiveForm(followUp),
            metadata: buildExecuteMetadata(executionId, {
              planItem: followUp,
              rootTaskId,
              parentTaskId: entry.taskId ?? entry.parentTaskId,
            }),
          });
          pendingItems.push({
            item: followUp,
            taskId: followUpTaskId,
            parentTaskId: entry.taskId ?? entry.parentTaskId,
          });
        }
      }

      progressState.completedItems = completed.length;
      progressState.blockedItems = blocked.length;
      progressState.remainingItems = pendingItems.length;
      progressState.activeWave = undefined;
      progressState.waves = [...waves];
      recordProgress(
        `Wave ${waveNumber} complete — ${summary.completedItems}/${summary.totalItems} done, ${summary.errorCount} errors, ${summary.queuedFollowUps} follow-ups`
      );
    }

    if (pendingItems.length > 0) {
      const reason = buildRemainingFollowUpsDescription(pendingItems.length);
      blocked.push({
        item: "remaining follow-ups",
        reason,
      });
      const blockerTaskId = await createBlockerTask("remaining follow-ups", reason, {
        rootTaskId,
        blockerType: "max_waves",
      });
      if (blockerTaskId) {
        blockerTaskIds.add(blockerTaskId);
      }
    }

    const details: ExecuteSummaryDetails = {
      planItems,
      waves,
      completed,
      blocked,
      filesTouched: [...filesTouched],
      validation: [...validation],
      remainingFollowUps: pendingItems.map((entry) => entry.item),
    };

    if (rootTaskId && taskBridge?.isAvailable()) {
      await taskBridge.setTaskActive(rootTaskId, false);
      await taskBridge.updateTask({
        taskId: rootTaskId,
        status: blockerTaskIds.size > 0 ? "pending" : "completed",
        metadata: buildExecuteMetadata(executionId, {
          planCount: planItems.length,
          result: blockerTaskIds.size > 0 ? "partial" : "done",
          blockedCount: blockerTaskIds.size,
          completedCount: completed.length,
          remainingFollowUps: details.remainingFollowUps,
          filesTouched: details.filesTouched,
          validation: details.validation,
        }),
        addBlockedBy: blockerTaskIds.size > 0 ? [...blockerTaskIds] : undefined,
      });
    }

    sendExecuteSummaryMessage(pi, buildSummaryMessage(details), details);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (rootTaskId && taskBridge?.isAvailable()) {
      await taskBridge.setTaskActive(rootTaskId, false);
      await taskBridge.updateTask({
        taskId: rootTaskId,
        status: "pending",
        metadata: buildExecuteMetadata(executionId, {
          result: "failed",
          error: message,
        }),
      });
    }
    sendExecuteSummaryMessage(pi, `## /execute failed\n\n- ${message}`, { error: message });
  } finally {
    removeTerminalInputListener();
    ctx.ui.setWidget(widgetKey, undefined);
    ctx.ui.setStatus(COMMAND_NAME, "");
  }
};

class ExecuteSummaryBody {
  private readonly text = new Text();

  constructor(
    private readonly details: ExecuteSummaryDetails | ExecuteErrorDetails,
    private readonly expanded: boolean,
    private readonly styles: ExecuteRenderStyles
  ) {}

  render(width: number): string[] {
    this.text.setText(
      buildExecuteSummaryRenderText(this.details, this.expanded, this.styles, Math.max(72, width - 4))
    );
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

export const startExecutePlan = (
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  executePlanImpl: typeof executePlan = executePlan
): void => {
  void executePlanImpl(pi, args, ctx).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`/execute failed: ${message}`, "error");
  });
};

export default function executeExtension(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("execute-summary", (message, { expanded }, theme) => {
    const details = isExecuteSummaryDetails(message.details) || isExecuteErrorDetails(message.details)
      ? message.details
      : { error: String(message.content ?? "Unknown /execute result") };
    const styles = {
      accent: (text: string) => theme.fg("accent", text),
      dim: (text: string) => theme.fg("dim", text),
      success: (text: string) => theme.fg("success", text),
      warning: (text: string) => theme.fg("warning", text),
      error: (text: string) => theme.fg("error", text),
    } satisfies ExecuteRenderStyles;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new ExecuteSummaryBody(details, expanded, styles));
    return box;
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Execute a plan via pi-lcm wave jobs: /execute <plan>",
    handler: async (args, ctx) => {
      startExecutePlan(pi, args ?? "", ctx);
    },
  });
}
