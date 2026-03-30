import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

import { ensureRuntime } from "../../../pi-lcm/src/runtime.ts";
import { buildMapTask, resolveMapAgent, runAgentTask } from "../../../pi-lcm/src/map-runner.ts";
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
const RISKY_STEP_PATTERN = /\b(add|change|create|delete|edit|fix|implement|migrate|move|refactor|remove|rename|replace|update|write)\b/i;

export interface ExecuteStepResult {
  status: "done" | "blocked" | "needs_followup";
  summary: string;
  filesTouched: string[];
  validation: string[];
  followUps: string[];
  blockers: string[];
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

const uniqueStrings = (values: string[]): string[] => [...new Set(values)];

const normalizePlanLine = (line: string): string =>
  line
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/, "")
    .trim();

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
  wave: number
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

  return {
    summary: {
      wave,
      jobId: completedJob.publicId,
      totalItems: items.length,
      completedItems: completedJob.completedItems,
      errorCount: completedJob.errorCount,
      queuedFollowUps,
    },
    results: results.filter((result): result is MapResultRecord => Boolean(result)),
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

export const executePlan = async (pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> => {
  const planItems = parsePlanItems(args);
  if (planItems.length === 0) {
    ctx.ui.notify("Usage: /execute <plan>", "warning");
    return;
  }

  ctx.ui.setStatus(COMMAND_NAME, `Executing ${planItems.length} plan item(s)...`);

  try {
    const runtime = await ensureRuntime(ctx);
    resolveMapAgent(ctx.cwd, EXECUTE_AGENT, "both");

    const pendingItems = [...planItems];
    const seenFollowUps = new Set(pendingItems);
    const completed: ExecuteCompletedItem[] = [];
    const blocked: ExecuteBlockedItem[] = [];
    const filesTouched = new Set<string>();
    const validation = new Set<string>();
    const waves: ExecuteWaveSummary[] = [];

    let waveNumber = 0;
    while (pendingItems.length > 0 && waveNumber < MAX_WAVES) {
      waveNumber += 1;
      const waveItems = pendingItems.splice(0, MAX_WAVE_ITEMS);
      ctx.ui.setStatus(COMMAND_NAME, `Wave ${waveNumber}: ${waveItems.length} item(s)`);

      const { summary, results } = await runWave(ctx, runtime, waveItems, waveNumber);
      waves.push(summary);

      for (const result of results) {
        if (result.isError) {
          blocked.push({
            item: result.item,
            reason: (result.errorMessage ?? result.stderr.trim()) || `Worker exited with code ${result.exitCode}`,
          });
          continue;
        }

        const structured = result.structuredOutput as ExecuteStepResult;
        const summary = summarizeExecuteStructuredResult(result.item, structured);

        if (summary.completed) {
          completed.push(summary.completed);
        }
        if (summary.blocked) {
          blocked.push(summary.blocked);
        }

        for (const file of summary.filesTouched) {
          filesTouched.add(file);
        }
        for (const check of summary.validation) {
          validation.add(check);
        }

        for (const followUp of summary.followUps) {
          if (seenFollowUps.has(followUp)) continue;
          seenFollowUps.add(followUp);
          pendingItems.push(followUp);
        }
      }
    }

    if (pendingItems.length > 0) {
      blocked.push({
        item: "remaining follow-ups",
        reason: `Stopped after ${MAX_WAVES} waves with ${pendingItems.length} item(s) still queued`,
      });
    }

    const details: ExecuteSummaryDetails = {
      planItems,
      waves,
      completed,
      blocked,
      filesTouched: [...filesTouched],
      validation: [...validation],
      remainingFollowUps: pendingItems,
    };

    pi.sendMessage({
      customType: "execute-summary",
      content: buildSummaryMessage(details),
      display: true,
      details,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pi.sendMessage({
      customType: "execute-summary",
      content: `## /execute failed\n\n- ${message}`,
      display: true,
      details: { error: message },
    });
  } finally {
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
      await executePlan(pi, args ?? "", ctx);
    },
  });
}
