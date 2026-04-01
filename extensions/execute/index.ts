import {
  Box,
  matchesKey,
} from "@mariozechner/pi-tui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { resolveMapAgent, runAgentTask } from "../../../pi-lcm/src/map-runner.ts";
import { ensureRuntime } from "../../../pi-lcm/src/runtime.ts";
import type { MapResultRecord } from "../../../pi-lcm/src/types.ts";

import {
  COMMAND_NAME,
  DEFAULT_MAX_ATTEMPTS,
  EXECUTE_AGENT,
  EXECUTE_COMMAND_NAME,
  EXECUTE_PROGRESS_DETAIL_FULL_LENGTH,
  EXECUTE_PROMPT,
  EXECUTE_ROOT_ACTIVE_FORM,
  EXECUTE_ROOT_SUBJECT,
  EXECUTE_TASK_SOURCE,
  MAX_WAVE_ITEMS,
  MAX_WAVES,
  nextExecuteWidgetKey,
  TASK_TEMPLATE,
} from "./constants";
import {
  buildExecuteWorkerTask,
  chooseWaveConcurrency,
  digestExecutePlanItems,
  getExecuteStepResult,
  parsePlanDocumentItems,
  parsePlanItems,
  parseWorkerResult,
  resolveExecutePlanInput,
} from "./plan";
import {
  buildExecuteLiveProgressEntry,
  buildExecuteLiveStatus,
  buildExecuteProgressWidgetLines,
  buildExecuteProgressWidgetRenderText,
  isExecuteCurrentStatusExpandable,
  updateExecuteProgressWidget,
} from "./progress";
import {
  buildExecuteSummaryRenderText,
  buildSummaryMessage,
  ExecuteSummaryBody,
  isExecuteErrorDetails,
  isExecuteSummaryDetails,
  sendExecuteSummaryMessage,
  summarizeExecuteStructuredResult,
} from "./summary";
import {
  buildBlockerDescription,
  buildExecuteItemActiveForm,
  buildExecuteItemDescription,
  buildExecuteMetadata,
  buildFollowUpDescription,
  buildRemainingFollowUpsDescription,
  createExecuteTasksBridge,
} from "./tasks";
import type {
  ExecuteLiveProgressUpdate,
  ExecutePlanDependencies,
  ExecuteProgressHistoryEntry,
  ExecuteProgressWidgetEntry,
  ExecuteProgressWidgetState,
  ExecuteQueuedItem,
  ExecuteStepResult,
  ExecuteSummaryDetails,
  ExecuteTaskCreateInput,
  ExecuteTasksBridge,
  ExecuteWaveItemCompletionUpdate,
  ExecuteWaveSummary,
} from "./types";

export {
  buildExecuteWorkerTask,
  chooseWaveConcurrency,
  digestExecutePlanItems,
  parsePlanDocumentItems,
  parsePlanItems,
  parseWorkerResult,
};
export {
  buildExecuteLiveProgressEntry,
  buildExecuteLiveStatus,
  buildExecuteProgressWidgetLines,
  buildExecuteProgressWidgetRenderText,
};
export {
  buildExecuteSummaryRenderText,
  ExecuteSummaryBody,
  isExecuteErrorDetails,
  isExecuteSummaryDetails,
  summarizeExecuteStructuredResult,
};
export { createExecuteTasksBridge };
export type {
  ExecutePlanDependencies,
  ExecuteStepResult,
  ExecuteSummaryDetails,
  ExecuteTaskCreateInput,
  ExecuteTasksBridge,
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
  onItemComplete?: (
    update: ExecuteWaveItemCompletionUpdate
  ) => void | Promise<void>
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

      const followUps = getExecuteStepResult(result.structuredOutput)?.followUps;
      await onItemComplete?.({
        wave,
        index,
        jobId: job.publicId,
        item,
        result,
        isError: result.isError,
        followUpCount: followUps?.length ?? 0,
      });

      results[index] = result;
    }
  };

  await Promise.all(
    Array.from({ length: maxConcurrency }, async () => worker())
  );
  const completedJob = await runtime.store.completeMapJob(
    job.publicId,
    "completed"
  );
  const queuedFollowUps = results.reduce((count, result) => {
    const followUps = getExecuteStepResult(result?.structuredOutput)?.followUps;
    if (!followUps) {
      return count;
    }
    return count + followUps.length;
  }, 0);

  const orderedResults = items.map((item, index) => {
    const result = results[index];
    if (!result) {
      throw new Error(
        `Wave ${wave} missing result for item ${index + 1}: ${item}`
      );
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

export const executePlan = async (
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: ExecutePlanDependencies = {}
): Promise<void> => {
  let planItems: string[];
  let digestInput;
  try {
    const resolvedPlan = await resolveExecutePlanInput(args, ctx.cwd);
    planItems = resolvedPlan.planItems;
    digestInput = resolvedPlan.digestInput;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message, "warning");
    return;
  }

  const widgetKey = nextExecuteWidgetKey();
  const progressHistory: ExecuteProgressHistoryEntry[] = [];
  let currentStatus = "";
  let currentStatusForWidget = "";
  let currentProgressEntry: ExecuteProgressWidgetEntry | undefined;
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
      expandedCurrentStatus,
      currentProgressEntry
    );
  };

  const recordProgress = (
    status: string,
    widgetStatus = status,
    entry?: ExecuteProgressWidgetEntry
  ): void => {
    currentStatus = status;
    currentStatusForWidget = widgetStatus;
    currentProgressEntry = entry;
    progressHistory.push({ status, entry });
    refreshProgressWidget();
    ctx.ui.setStatus(COMMAND_NAME, status);
  };

  const removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
    if (
      !(matchesKey(data, "ctrl+o") || data === "\u000f") ||
      !isExecuteCurrentStatusExpandable(
        currentStatusForWidget || currentStatus,
        currentProgressEntry
      )
    ) {
      return undefined;
    }

    expandedCurrentStatus = !expandedCurrentStatus;
    refreshProgressWidget();
    return { consume: true };
  });

  const digestPlanItemsImpl =
    dependencies.digestPlanItems ?? digestExecutePlanItems;
  if (digestInput) {
    recordProgress(
      `Digesting ${digestInput.sourceLabel} into executable tasks...`
    );
    try {
      const digestedItems = await digestPlanItemsImpl(digestInput, ctx);
      if (digestedItems.length > 0) {
        planItems = digestedItems;
        progressState.remainingItems = planItems.length;
        recordProgress(`Prepared ${planItems.length} executable task(s)`);
      } else {
        ctx.ui.notify(
          "Unable to digest plan, using parsed items: digester returned no tasks",
          "warning"
        );
        recordProgress(`Using ${planItems.length} parsed plan item(s)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Unable to digest plan, using parsed items: ${message}`,
        "warning"
      );
      recordProgress(`Using ${planItems.length} parsed plan item(s)`);
    }
  }

  if (planItems.length === 0) {
    ctx.ui.notify("Usage: /execute-wave <plan>", "warning");
    ctx.ui.setWidget(widgetKey, undefined);
    ctx.ui.setStatus(COMMAND_NAME, "");
    return;
  }

  const ensureRuntimeImpl = dependencies.ensureRuntime ?? ensureRuntime;
  const runWaveImpl = dependencies.runWave ?? runWave;
  const createTasksBridgeImpl =
    dependencies.createTasksBridge ?? createExecuteTasksBridge;
  const executionId = (
    dependencies.createExecutionId ?? (() => `execute:${Date.now()}`)
  )();

  let taskBridge: ExecuteTasksBridge | null = null;
  let rootTaskId: string | undefined;

  recordProgress(`Executing ${planItems.length} plan item(s)...`);

  try {
    const runtime = await ensureRuntimeImpl(ctx);
    resolveMapAgent(ctx.cwd, EXECUTE_AGENT, "both");
    taskBridge = await createTasksBridgeImpl(pi, ctx);
    if (!taskBridge) {
      ctx.ui.notify(
        "/execute-wave: pi-tasks bridge unavailable — load pi-tasks to see live task progress",
        "info"
      );
    }

    const pendingItems: ExecuteQueuedItem[] = [];
    const seenFollowUps = new Set(planItems);
    const completed: ExecuteSummaryDetails["completed"] = [];
    const blocked: ExecuteSummaryDetails["blocked"] = [];
    const filesTouched = new Set<string>();
    const validation = new Set<string>();
    const waves: ExecuteWaveSummary[] = [];
    const blockerTaskIds = new Set<string>();

    const createBridgeTask = async (
      input: ExecuteTaskCreateInput
    ): Promise<string | undefined> => {
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
        metadata: buildExecuteMetadata(executionId, {
          planCount: planItems.length,
        }),
      });
      if (rootTaskId) {
        await taskBridge.updateTask({
          taskId: rootTaskId,
          status: "in_progress",
          owner: EXECUTE_TASK_SOURCE,
          metadata: buildExecuteMetadata(executionId, {
            planCount: planItems.length,
          }),
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
          const compactStatus = buildExecuteLiveStatus(
            update.wave,
            update.item,
            update.event
          );
          recordProgress(
            compactStatus,
            compactStatus,
            buildExecuteLiveProgressEntry(update.wave, update.item, update.event, {
              detailMaxLength: EXECUTE_PROGRESS_DETAIL_FULL_LENGTH,
            })
          );
        },
        async (update) => {
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
                const structured = getExecuteStepResult(
                  update.result.structuredOutput
                );
                if (!structured) {
                  throw new Error(
                    `Wave ${update.wave} returned an invalid structured result for ${update.item}`
                  );
                }
                const resultSummary = summarizeExecuteStructuredResult(
                  update.item,
                  structured
                );
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
          } else {
            const structured = getExecuteStepResult(update.result?.structuredOutput);
            if (structured) {
              const resultSummary = summarizeExecuteStructuredResult(
                update.item,
                structured
              );
              completedDelta = resultSummary.completed ? 1 : 0;
              blockedDelta = resultSummary.blocked ? 1 : 0;
            } else {
              completedDelta = 1;
            }
          }

          const completedItems = progressState.activeWave.completedItems + 1;
          progressState.activeWave = {
            ...progressState.activeWave,
            activeItem: update.item,
            completedItems,
            errorCount:
              progressState.activeWave.errorCount + (update.isError ? 1 : 0),
            queuedFollowUps:
              progressState.activeWave.queuedFollowUps + update.followUpCount,
          };
          progressState.completedItems += completedDelta;
          progressState.blockedItems += blockedDelta;
          progressState.remainingItems =
            pendingItems.length +
            Math.max(0, waveItems.length - completedItems);
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
            (result.errorMessage ?? result.stderr.trim()) ||
            `Worker exited with code ${result.exitCode}`;
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

        const structured = getExecuteStepResult(result.structuredOutput);
        if (!structured) {
          throw new Error(
            `Wave ${waveNumber} returned an invalid structured result for ${result.item}`
          );
        }
        const resultSummary = summarizeExecuteStructuredResult(
          result.item,
          structured
        );

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
            const blockerTaskId = await createBlockerTask(
              result.item,
              resultSummary.blocked.reason,
              {
                blockerForTaskId: entry.taskId,
                rootTaskId,
              }
            );
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
      const blockerTaskId = await createBlockerTask(
        "remaining follow-ups",
        reason,
        {
          rootTaskId,
          blockerType: "max_waves",
        }
      );
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
    sendExecuteSummaryMessage(pi, `## /execute-wave failed\n\n- ${message}`, {
      error: message,
    });
  } finally {
    removeTerminalInputListener();
    ctx.ui.setWidget(widgetKey, undefined);
    ctx.ui.setStatus(COMMAND_NAME, "");
  }
};

export const startExecutePlan = (
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  executePlanImpl: typeof executePlan = executePlan
): void => {
  void executePlanImpl(pi, args, ctx).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`/execute-wave failed: ${message}`, "error");
  });
};

export const buildExecuteCommandMessage = (args: string): string => {
  const task = args.trim();
  return task ? `${EXECUTE_PROMPT}\n\nTask: ${task}` : EXECUTE_PROMPT;
};

export default function executeExtension(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(
    "execute-summary",
    (message, { expanded }, theme) => {
      const details =
        isExecuteSummaryDetails(message.details) ||
        isExecuteErrorDetails(message.details)
          ? message.details
          : { error: String(message.content ?? "Unknown /execute-wave result") };
      const styles = {
        accent: (text: string) => theme.fg("accent", text),
        dim: (text: string) => theme.fg("dim", text),
        success: (text: string) => theme.fg("success", text),
        warning: (text: string) => theme.fg("warning", text),
        error: (text: string) => theme.fg("error", text),
      };
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(new ExecuteSummaryBody(details, expanded, styles));
      return box;
    }
  );

  pi.registerCommand(EXECUTE_COMMAND_NAME, {
    description: "Execute a plan via main-session task orchestration: /execute <plan>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify("Usage: /execute <plan>", "warning");
        return;
      }

      const message = buildExecuteCommandMessage(task);
      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Queued /execute as a follow-up", "info");
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Execute a plan via pi-lcm wave jobs: /execute-wave <plan>",
    handler: async (args, ctx) => {
      startExecutePlan(pi, args ?? "", ctx);
    },
  });
}
