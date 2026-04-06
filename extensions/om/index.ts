import {
  convertToLlm,
  type ExtensionAPI,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";

import { createOmBranchScope, createOmStateEnvelope } from "./branch";
import {
  canActivateOmObservationBuffer,
  canActivateOmReflectionBuffer,
  createOmObservationActivationWindow,
  createOmObservationBufferEnvelope,
  createOmObservationBufferWindow,
  createOmReflectionActivationWindow,
  createOmReflectionBufferEnvelope,
  createOmReflectionBufferWindow,
  hasOmObserverBufferPayload,
  hasOmReflectorBufferPayload,
  updateOmObservationBufferStatus,
  updateOmReflectionBufferStatus,
} from "./buffer";
import { generateOmCompactionSummary } from "./compaction";
import {
  createOmConfigSnapshot,
  DEFAULT_OM_CONFIG_SNAPSHOT,
  mergeOmConfigSnapshot,
} from "./config";
import { loadOmConfig } from "./file-config";
import {
  applyOmObserverResult,
  createEmptyOmObserverResult,
  createOmObserverWindow,
  invokeOmObserver,
} from "./observer";
import { injectOmHeaderMessage } from "./prompt-integration";
import {
  applyOmReflectorResult,
  createEmptyOmReflectorResult,
  createOmReflectorWindow,
  invokeOmReflector,
} from "./reflector";
import {
  planOmStateRestore,
  selectLatestOmObservationBufferForBranch,
  selectLatestOmReflectionBufferForBranch,
} from "./restore";
import { createOmStatusSnapshot, showOmStatusView } from "./status";
import type {
  OmConfigInput,
  OmObservationBufferEnvelopeV1,
  OmRecentEvent,
  OmReflectionBufferEnvelopeV1,
  OmStateV1,
} from "./types";
import {
  OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
  OM_REFLECTION_BUFFER_CUSTOM_TYPE,
  OM_STATE_CUSTOM_TYPE,
  OM_STATE_VERSION,
} from "./version";

export {
  createOmBranchScope,
  createOmStateEnvelope,
  diffOmBranchEntriesSince,
  getLatestOmStateEnvelope,
} from "./branch";
export {
  canActivateOmObservationBuffer,
  canActivateOmReflectionBuffer,
  createOmObservationActivationWindow,
  createOmObservationBufferEnvelope,
  createOmObservationBufferWindow,
  createOmReflectionActivationWindow,
  createOmReflectionBufferEnvelope,
  createOmReflectionBufferWindow,
  hasOmObserverBufferPayload,
  hasOmReflectorBufferPayload,
  resolveOmBufferTokens,
  updateOmObservationBufferStatus,
  updateOmReflectionBufferStatus,
} from "./buffer";
export {
  buildOmCompactionPrompt,
  generateOmCompactionSummary,
} from "./compaction";
export {
  createOmConfigSnapshot,
  DEFAULT_OM_CONFIG_SNAPSHOT,
  mergeOmConfigSnapshot,
} from "./config";
export { getOmConfigPath, loadOmConfig } from "./file-config";
export {
  applyOmObserverResult,
  buildOmObserverPromptForWindow,
  createEmptyOmObserverResult,
  createOmObserverPromptInput,
  createOmObserverWindow,
  invokeOmObserver,
  parseOmObserverResultText,
  serializeOmObserverEntry,
} from "./observer";
export {
  createOmHeaderContextMessage,
  injectOmHeaderMessage,
  mergeOmCompactionSummary,
  OM_HEADER_CUSTOM_TYPE,
  shouldInjectOmHeader,
} from "./prompt-integration";
export {
  buildOmCompactionPayload,
  buildOmHeader,
  buildOmObserverPrompt,
  buildOmReflectorPrompt,
} from "./prompts";
export {
  applyOmReflectorResult,
  buildOmReflectorPromptForWindow,
  createEmptyOmReflectorResult,
  createOmReflectorPromptInput,
  createOmReflectorWindow,
  invokeOmReflector,
  parseOmReflectorResultText,
} from "./reflector";
export type {
  OmBufferRestoreSelection,
  OmRestorePlan,
  OmRestoreReason,
  OmRestoreSelection,
} from "./restore";
export {
  normalizeOmStateEnvelope,
  planOmStateRestore,
  selectLatestOmObservationBufferForBranch,
  selectLatestOmReflectionBufferForBranch,
  selectLatestOmStateEnvelopeForBranch,
} from "./restore";
export {
  isOmObserverResult,
  isOmReflectorResult,
  isOmStateEnvelopeV1,
  isOmStateV1,
  OmBranchScopeSchema,
  OmConfigSnapshotSchema,
  OmObserverResultSchema,
  OmReflectorResultSchema,
  OmStateEnvelopeV1Schema,
  OmStateV1Schema,
} from "./schema";
export {
  createOmStatusSnapshot,
  formatOmStatusSummary,
  showOmStatusView,
} from "./status";
export type {
  OmActiveThread,
  OmBranchDelta,
  OmBranchScope,
  OmCompactionPayloadInput,
  OmConfigInput,
  OmConfigSnapshot,
  OmHeaderInput,
  OmObservation,
  OmObservationBuffer,
  OmObservationBufferEnvelopeV1,
  OmObserverApplyResult,
  OmObserverPromptInput,
  OmObserverResult,
  OmObserverWindow,
  OmPromptTurn,
  OmRecentEvent,
  OmReflection,
  OmReflectionBuffer,
  OmReflectionBufferEnvelopeV1,
  OmReflectorApplyResult,
  OmReflectorPromptInput,
  OmReflectorResult,
  OmReflectorWindow,
  OmStableFact,
  OmStateEnvelopeV1,
  OmStateV1,
} from "./types";
export {
  OM_EXTENSION_NAME,
  OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
  OM_OBSERVATION_KINDS,
  OM_PROMPT_VERSION,
  OM_REFLECTION_BUFFER_CUSTOM_TYPE,
  OM_STATE_CUSTOM_TYPE,
  OM_STATE_VERSION,
  OM_THREAD_STATUSES,
} from "./version";

interface OmRestorePlanCacheContext {
  sessionManager: {
    getEntries(): readonly {
      id: string;
      type: string;
      customType?: string;
      data?: unknown;
    }[];
    getBranch(): readonly { id: string }[];
  };
}

interface OmLifecycleContext extends OmRestorePlanCacheContext {
  model?: Parameters<typeof invokeOmObserver>[0]["model"];
  modelRegistry: Parameters<typeof invokeOmObserver>[0]["modelRegistry"];
  ui?: {
    notify(
      message: string,
      level?: "info" | "warning" | "error" | "success"
    ): void;
  };
}

interface OmRuntimeState {
  restorePlan: ReturnType<
    ReturnType<typeof createOmRestorePlanCache>["getCachedRestorePlan"]
  >;
  state: OmStateV1;
  pendingObservationBuffer: OmObservationBufferEnvelopeV1 | null;
  pendingReflectionBuffer: OmReflectionBufferEnvelopeV1 | null;
  recentEvents: OmRecentEvent[];
}

interface OmCommandContext extends OmLifecycleContext {
  ui: {
    notify(
      message: string,
      level?: "info" | "warning" | "error" | "success"
    ): void;
  };
}

const OM_RECENT_EVENT_LIMIT = 8;

function createOmInvokeContext(
  ctx: OmLifecycleContext
): Parameters<typeof invokeOmObserver>[0] {
  return {
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
  };
}

function appendOmRecentEvents(
  currentEvents: readonly OmRecentEvent[],
  nextEvents: readonly OmRecentEvent[]
): OmRecentEvent[] {
  return [...currentEvents, ...nextEvents].slice(-OM_RECENT_EVENT_LIMIT);
}

function pushOmRecentEvents(
  runtimeState: OmRuntimeState,
  nextEvents: readonly OmRecentEvent[]
): OmRuntimeState {
  if (nextEvents.length === 0) {
    return runtimeState;
  }

  return {
    ...runtimeState,
    recentEvents: appendOmRecentEvents(runtimeState.recentEvents, nextEvents),
  };
}

function pluralize(word: string, count: number): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function joinOmDeltaParts(parts: string[]): string {
  if (parts.length === 0) {
    return "no durable memory";
  }

  return parts.join(", ");
}

function createOmEvent(input: {
  createdAt: string;
  level: OmRecentEvent["level"];
  message: string;
}): OmRecentEvent {
  return {
    createdAt: input.createdAt,
    level: input.level,
    message: input.message,
  };
}

function createObserverAppliedEvent(
  updatedAt: string,
  observerResult: import("./types").OmObserverResult
): OmRecentEvent {
  const parts = [
    observerResult.observations.length > 0
      ? `+${pluralize("observation", observerResult.observations.length)}`
      : null,
    observerResult.stableFacts.length > 0
      ? `+${pluralize("fact", observerResult.stableFacts.length)}`
      : null,
    observerResult.activeThreads.length > 0
      ? `+${pluralize("thread", observerResult.activeThreads.length)}`
      : null,
  ].filter((value): value is string => Boolean(value));

  return createOmEvent({
    createdAt: updatedAt,
    level: "success",
    message: `OM observer applied: ${joinOmDeltaParts(parts)}.`,
  });
}

function createObserverCursorAdvanceEvent(
  updatedAt: string,
  pendingEntryCount: number
): OmRecentEvent {
  return createOmEvent({
    createdAt: updatedAt,
    level: "info",
    message: `OM advanced cursor across ${pluralize("pending entry", pendingEntryCount)}; no new durable memory.`,
  });
}

function createObservationBufferEvent(
  updatedAt: string,
  sourceEntryCount: number
): OmRecentEvent {
  return createOmEvent({
    createdAt: updatedAt,
    level: "info",
    message: `OM buffered observation work for ${pluralize("entry", sourceEntryCount)}.`,
  });
}

function createObservationBufferActivationEvent(
  updatedAt: string,
  observerResult: import("./types").OmObserverResult
): OmRecentEvent {
  const appliedEvent = createObserverAppliedEvent(updatedAt, observerResult);
  return {
    ...appliedEvent,
    message: appliedEvent.message.replace(
      "OM observer applied",
      "OM activated buffered observation"
    ),
  };
}

function createBufferSupersededEvent(
  updatedAt: string,
  kind: "observation" | "reflection"
): OmRecentEvent {
  return createOmEvent({
    createdAt: updatedAt,
    level: "warning",
    message: `OM superseded stale ${kind} buffer.`,
  });
}

function createReflectionBufferEvent(
  updatedAt: string,
  sourceObservationCount: number
): OmRecentEvent {
  return createOmEvent({
    createdAt: updatedAt,
    level: "info",
    message: `OM buffered reflection work for ${pluralize("observation", sourceObservationCount)}.`,
  });
}

function createReflectionAppliedEvent(
  updatedAt: string,
  observationCount: number,
  reflectionCount: number,
  prefix = "OM reflected"
): OmRecentEvent {
  return createOmEvent({
    createdAt: updatedAt,
    level: "success",
    message: `${prefix} ${pluralize("observation", observationCount)} into ${pluralize("reflection", reflectionCount)}.`,
  });
}

function notifyOmRecentEvents(
  ctx: OmLifecycleContext,
  recentEvents: readonly OmRecentEvent[]
): void {
  if (typeof ctx.ui?.notify !== "function") {
    return;
  }

  for (const event of recentEvents) {
    ctx.ui.notify(event.message, event.level);
  }
}

export interface OmExtensionDeps {
  config?: OmConfigInput | Record<string, unknown>;
  invokeObserverFn?: typeof invokeOmObserver;
  invokeReflectorFn?: typeof invokeOmReflector;
  now?: () => string;
}

function applyOmRuntimeConfig(
  state: OmStateV1,
  config?: OmConfigInput | Record<string, unknown>
): OmStateV1 {
  return {
    ...state,
    configSnapshot: config
      ? mergeOmConfigSnapshot(state.configSnapshot, config)
      : createOmConfigSnapshot(state.configSnapshot),
  };
}

function createEmptyOmState(
  now: () => string = () => new Date().toISOString(),
  config?: OmConfigInput | Record<string, unknown>
): OmStateV1 {
  return {
    version: OM_STATE_VERSION,
    lastProcessedEntryId: null,
    observations: [],
    reflections: [],
    stableFacts: [],
    activeThreads: [],
    configSnapshot: config
      ? mergeOmConfigSnapshot(DEFAULT_OM_CONFIG_SNAPSHOT, config)
      : DEFAULT_OM_CONFIG_SNAPSHOT,
    updatedAt: now(),
  };
}

function createOmRuntimeState(
  restorePlan: ReturnType<
    ReturnType<typeof createOmRestorePlanCache>["getCachedRestorePlan"]
  >,
  pendingObservationBuffer: OmObservationBufferEnvelopeV1 | null,
  pendingReflectionBuffer: OmReflectionBufferEnvelopeV1 | null,
  now: () => string,
  config?: OmConfigInput | Record<string, unknown>,
  recentEvents: readonly OmRecentEvent[] = []
): OmRuntimeState {
  return {
    restorePlan,
    state: restorePlan?.envelope
      ? applyOmRuntimeConfig(
          structuredClone(restorePlan.envelope.state),
          config
        )
      : createEmptyOmState(now, config),
    pendingObservationBuffer,
    pendingReflectionBuffer,
    recentEvents: [...recentEvents],
  };
}

export function createOmRestorePlanCache() {
  let cachedRestorePlan: import("./restore").OmRestorePlan | null = null;

  return {
    getCachedRestorePlan() {
      return cachedRestorePlan;
    },
    setCachedRestorePlan(
      restorePlan: import("./restore").OmRestorePlan | null
    ) {
      cachedRestorePlan = restorePlan;
      return cachedRestorePlan;
    },
    refreshCachedRestorePlan(ctx: OmRestorePlanCacheContext) {
      cachedRestorePlan = planOmStateRestore(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getBranch()
      );
      return cachedRestorePlan;
    },
  };
}

export function createOmExtension(deps: OmExtensionDeps = {}) {
  const invokeObserverFn = deps.invokeObserverFn ?? invokeOmObserver;
  const invokeReflectorFn = deps.invokeReflectorFn ?? invokeOmReflector;
  const now = deps.now ?? (() => new Date().toISOString());
  const config = deps.config;

  return function omExtension(pi: ExtensionAPI): void {
    const restorePlanCache = createOmRestorePlanCache();
    let runtimeState: OmRuntimeState | null = null;

    const refreshRuntimeState = (
      ctx: OmRestorePlanCacheContext
    ): OmRuntimeState => {
      const entries = ctx.sessionManager.getEntries();
      const branchEntries = ctx.sessionManager.getBranch();
      const restorePlan = restorePlanCache.setCachedRestorePlan(
        planOmStateRestore(entries, branchEntries)
      );
      const nextRuntimeState = createOmRuntimeState(
        restorePlan,
        selectLatestOmObservationBufferForBranch(entries, branchEntries).match
          ?.envelope ?? null,
        selectLatestOmReflectionBufferForBranch(entries, branchEntries).match
          ?.envelope ?? null,
        now,
        config,
        runtimeState?.recentEvents ?? []
      );
      runtimeState = nextRuntimeState;
      return nextRuntimeState;
    };

    const getRuntimeState = (ctx: OmRestorePlanCacheContext): OmRuntimeState =>
      runtimeState ?? refreshRuntimeState(ctx);

    const persistRuntimeState = (
      ctx: OmRestorePlanCacheContext,
      state: OmStateV1
    ): OmRuntimeState => {
      const nextState = applyOmRuntimeConfig(state, config);
      const envelope = createOmStateEnvelope(
        nextState,
        createOmBranchScope(ctx.sessionManager.getBranch())
      );
      pi.appendEntry(OM_STATE_CUSTOM_TYPE, envelope);
      return refreshRuntimeState(ctx);
    };

    const persistObservationBuffer = (
      ctx: OmRestorePlanCacheContext,
      envelope: OmObservationBufferEnvelopeV1
    ): OmRuntimeState => {
      pi.appendEntry(OM_OBSERVATION_BUFFER_CUSTOM_TYPE, {
        buffer: envelope.buffer,
      });
      return refreshRuntimeState(ctx);
    };

    const persistReflectionBuffer = (
      ctx: OmRestorePlanCacheContext,
      envelope: OmReflectionBufferEnvelopeV1
    ): OmRuntimeState => {
      pi.appendEntry(OM_REFLECTION_BUFFER_CUSTOM_TYPE, {
        buffer: envelope.buffer,
      });
      return refreshRuntimeState(ctx);
    };

    const notifyStatus = async (ctx: OmCommandContext): Promise<void> => {
      const currentRuntimeState = getRuntimeState(ctx);
      const snapshot = createOmStatusSnapshot({
        state: currentRuntimeState.state,
        branchEntries: ctx.sessionManager.getBranch(),
        restorePlan: currentRuntimeState.restorePlan,
        pendingObservationBuffer: currentRuntimeState.pendingObservationBuffer,
        pendingReflectionBuffer: currentRuntimeState.pendingReflectionBuffer,
        recentEvents: currentRuntimeState.recentEvents,
      });

      await showOmStatusView(ctx, snapshot);
    };

    const runObserverAndReflector = async (
      ctx: OmLifecycleContext,
      currentRuntimeState: OmRuntimeState,
      options: { forceRebuild?: boolean } = {}
    ): Promise<{
      state: OmStateV1;
      shouldPersist: boolean;
      recentEvents: OmRecentEvent[];
    }> => {
      const branchEntries = ctx.sessionManager.getBranch();
      const shouldRebuild =
        options.forceRebuild === true ||
        currentRuntimeState.restorePlan?.mode === "rebuild";
      const rebuildMaxTurns = Math.max(1, branchEntries.length);
      let baseState = shouldRebuild
        ? createEmptyOmState(now, config)
        : currentRuntimeState.state;
      let window = createOmObserverWindow(
        branchEntries,
        shouldRebuild ? null : baseState.lastProcessedEntryId,
        {
          maxTurns: shouldRebuild
            ? rebuildMaxTurns
            : baseState.configSnapshot.observerMaxTurns,
          observationMessageTokens: shouldRebuild
            ? 1
            : baseState.configSnapshot.observation.messageTokens,
          blockAfter: shouldRebuild
            ? 1
            : baseState.configSnapshot.observation.blockAfter,
        }
      );

      if (window.status === "rebuild") {
        baseState = createEmptyOmState(now, config);
        window = createOmObserverWindow(branchEntries, null, {
          maxTurns: rebuildMaxTurns,
          observationMessageTokens: 1,
          blockAfter: 1,
        });
      }

      let nextRuntimeState = currentRuntimeState;
      const updatedAt = now();
      const invokeContext = createOmInvokeContext(ctx);
      const recentEvents: OmRecentEvent[] = [];

      if (
        !shouldRebuild &&
        window.status !== "ready" &&
        !nextRuntimeState.pendingObservationBuffer
      ) {
        const observationBufferWindow = createOmObservationBufferWindow(
          branchEntries,
          baseState.lastProcessedEntryId,
          baseState.configSnapshot
        );

        if (observationBufferWindow) {
          const bufferedObserverResult = await invokeObserverFn(
            invokeContext,
            baseState,
            observationBufferWindow
          );

          if (hasOmObserverBufferPayload(bufferedObserverResult)) {
            nextRuntimeState = persistObservationBuffer(
              ctx,
              createOmObservationBufferEnvelope(
                observationBufferWindow,
                bufferedObserverResult,
                updatedAt
              )
            );
            recentEvents.push(
              createObservationBufferEvent(
                updatedAt,
                observationBufferWindow.pendingEntryIds.length
              )
            );
          }
        }
      }

      const shouldActivateObservationBuffer = canActivateOmObservationBuffer(
        baseState,
        nextRuntimeState.pendingObservationBuffer,
        window
      );
      if (
        window.status === "ready" &&
        nextRuntimeState.pendingObservationBuffer &&
        !shouldActivateObservationBuffer
      ) {
        nextRuntimeState = persistObservationBuffer(
          ctx,
          updateOmObservationBufferStatus(
            nextRuntimeState.pendingObservationBuffer,
            "superseded",
            updatedAt
          )
        );
        recentEvents.push(
          createBufferSupersededEvent(updatedAt, "observation")
        );
      }

      const observerResult = shouldActivateObservationBuffer
        ? (
            nextRuntimeState.pendingObservationBuffer as OmObservationBufferEnvelopeV1
          ).buffer.result
        : window.status === "ready"
          ? await invokeObserverFn(invokeContext, baseState, window)
          : createEmptyOmObserverResult();
      const observerApplied = shouldActivateObservationBuffer
        ? applyOmObserverResult(
            baseState,
            createOmObservationActivationWindow(
              nextRuntimeState.pendingObservationBuffer as OmObservationBufferEnvelopeV1,
              window
            ),
            observerResult,
            updatedAt
          )
        : applyOmObserverResult(baseState, window, observerResult, updatedAt);

      if (shouldActivateObservationBuffer) {
        nextRuntimeState = persistObservationBuffer(
          ctx,
          updateOmObservationBufferStatus(
            nextRuntimeState.pendingObservationBuffer as OmObservationBufferEnvelopeV1,
            "activated",
            updatedAt
          )
        );
        recentEvents.push(
          createObservationBufferActivationEvent(updatedAt, observerResult)
        );
      } else if (observerApplied.status === "applied") {
        recentEvents.push(
          createObserverAppliedEvent(updatedAt, observerResult)
        );
      } else if (
        observerApplied.reason === "cursor-advanced" &&
        window.pendingEntryIds.length > 0
      ) {
        recentEvents.push(
          createObserverCursorAdvanceEvent(
            updatedAt,
            window.pendingEntryIds.length
          )
        );
      }

      const reflectorWindow = createOmReflectorWindow(observerApplied.state);
      if (
        reflectorWindow.status !== "ready" &&
        !nextRuntimeState.pendingReflectionBuffer
      ) {
        const reflectionBufferWindow = createOmReflectionBufferWindow(
          observerApplied.state
        );

        if (reflectionBufferWindow) {
          const bufferedReflectorResult = await invokeReflectorFn(
            invokeContext,
            observerApplied.state,
            reflectionBufferWindow
          );

          if (hasOmReflectorBufferPayload(bufferedReflectorResult)) {
            nextRuntimeState = persistReflectionBuffer(
              ctx,
              createOmReflectionBufferEnvelope(
                observerApplied.state,
                reflectionBufferWindow,
                bufferedReflectorResult,
                updatedAt
              )
            );
            recentEvents.push(
              createReflectionBufferEvent(
                updatedAt,
                reflectionBufferWindow.observationsToReflect.length
              )
            );
          }
        }
      }

      const shouldActivateReflectionBuffer = canActivateOmReflectionBuffer(
        nextRuntimeState.pendingReflectionBuffer,
        reflectorWindow
      );
      if (
        reflectorWindow.status === "ready" &&
        nextRuntimeState.pendingReflectionBuffer &&
        !shouldActivateReflectionBuffer
      ) {
        nextRuntimeState = persistReflectionBuffer(
          ctx,
          updateOmReflectionBufferStatus(
            nextRuntimeState.pendingReflectionBuffer,
            "superseded",
            updatedAt
          )
        );
        recentEvents.push(createBufferSupersededEvent(updatedAt, "reflection"));
      }

      const reflectorResult = shouldActivateReflectionBuffer
        ? (
            nextRuntimeState.pendingReflectionBuffer as OmReflectionBufferEnvelopeV1
          ).buffer.result
        : reflectorWindow.status === "ready"
          ? await invokeReflectorFn(
              invokeContext,
              observerApplied.state,
              reflectorWindow
            )
          : createEmptyOmReflectorResult();
      const reflectorApplied = shouldActivateReflectionBuffer
        ? applyOmReflectorResult(
            observerApplied.state,
            createOmReflectionActivationWindow(
              observerApplied.state,
              nextRuntimeState.pendingReflectionBuffer as OmReflectionBufferEnvelopeV1
            ),
            reflectorResult,
            updatedAt
          )
        : applyOmReflectorResult(
            observerApplied.state,
            reflectorWindow,
            reflectorResult,
            updatedAt
          );

      if (shouldActivateReflectionBuffer) {
        const activatedReflectionObservationCount =
          createOmReflectionActivationWindow(
            observerApplied.state,
            nextRuntimeState.pendingReflectionBuffer as OmReflectionBufferEnvelopeV1
          ).observationsToReflect.length;

        nextRuntimeState = persistReflectionBuffer(
          ctx,
          updateOmReflectionBufferStatus(
            nextRuntimeState.pendingReflectionBuffer as OmReflectionBufferEnvelopeV1,
            "activated",
            updatedAt
          )
        );
        recentEvents.push(
          createReflectionAppliedEvent(
            updatedAt,
            activatedReflectionObservationCount,
            reflectorResult.reflections.length,
            "OM activated buffered reflection"
          )
        );
      } else if (reflectorApplied.status === "applied") {
        recentEvents.push(
          createReflectionAppliedEvent(
            updatedAt,
            reflectorWindow.observationsToReflect.length,
            reflectorResult.reflections.length
          )
        );
      }

      return {
        state: reflectorApplied.state,
        shouldPersist:
          observerApplied.shouldPersist || reflectorApplied.shouldPersist,
        recentEvents,
      };
    };

    const rebuildState = async (ctx: OmCommandContext): Promise<void> => {
      const currentRuntimeState = getRuntimeState(ctx);
      const nextRuntimeState = await runObserverAndReflector(
        ctx,
        currentRuntimeState,
        { forceRebuild: true }
      );

      runtimeState = {
        restorePlan: null,
        state: nextRuntimeState.state,
        pendingObservationBuffer: null,
        pendingReflectionBuffer: null,
        recentEvents: appendOmRecentEvents(
          currentRuntimeState.recentEvents,
          nextRuntimeState.recentEvents
        ),
      };

      if (nextRuntimeState.shouldPersist) {
        persistRuntimeState(ctx, nextRuntimeState.state);
        notifyOmRecentEvents(ctx, nextRuntimeState.recentEvents);
        ctx.ui.notify("Observational memory rebuilt.", "success");
        return;
      }

      ctx.ui.notify(
        "Observational memory rebuild produced no changes.",
        "info"
      );
    };

    pi.registerCommand("om-status", {
      description: "Show observational memory status",
      handler: async (_args, ctx) =>
        await notifyStatus(ctx as OmCommandContext),
    });

    pi.registerCommand("om-clear", {
      description:
        "Clear persisted observational memory state for the current branch",
      handler: async (_args, ctx) => {
        const clearedState = createEmptyOmState(now);
        persistRuntimeState(ctx as OmCommandContext, clearedState);
        (ctx as OmCommandContext).ui.notify(
          "Observational memory cleared.",
          "success"
        );
      },
    });

    pi.registerCommand("om-rebuild", {
      description: "Rebuild observational memory from the current branch",
      handler: async (_args, ctx) => {
        await rebuildState(ctx as OmCommandContext);
      },
    });

    pi.on("session_start", (_event, ctx) => {
      refreshRuntimeState(ctx);
    });

    pi.on("context", (event) => {
      if (!runtimeState) {
        return;
      }

      return {
        messages: injectOmHeaderMessage(event.messages, runtimeState.state),
      };
    });

    pi.on("session_before_compact", async (event, ctx) => {
      if (!runtimeState?.state) {
        return;
      }

      const conversationText = serializeConversation(
        convertToLlm([
          ...event.preparation.messagesToSummarize,
          ...event.preparation.turnPrefixMessages,
        ])
      );
      const compaction = await generateOmCompactionSummary(
        {
          model: ctx.model,
          modelRegistry: ctx.modelRegistry,
        },
        runtimeState.state,
        {
          conversationText,
          previousSummary: event.preparation.previousSummary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
        {
          signal: event.signal,
        }
      );

      if (!compaction) {
        return;
      }

      return { compaction };
    });

    pi.on("turn_end", async (_event, ctx) => {
      const currentRuntimeState = runtimeState ?? refreshRuntimeState(ctx);
      const nextRuntimeState = await runObserverAndReflector(
        ctx,
        currentRuntimeState
      );

      if (!nextRuntimeState.shouldPersist) {
        runtimeState = pushOmRecentEvents(
          refreshRuntimeState(ctx),
          nextRuntimeState.recentEvents
        );
        notifyOmRecentEvents(ctx, nextRuntimeState.recentEvents);
        return;
      }

      runtimeState = pushOmRecentEvents(
        persistRuntimeState(ctx, nextRuntimeState.state),
        nextRuntimeState.recentEvents
      );
      notifyOmRecentEvents(ctx, nextRuntimeState.recentEvents);
    });
  };
}

export default createOmExtension({ config: loadOmConfig() });
