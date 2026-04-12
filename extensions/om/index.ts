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
  serializeOmObserverEntry,
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
  OmConfigSnapshot,
  OmObservationBufferEnvelopeV1,
  OmObserverDiagnostic,
  OmObserverDiagnosticCode,
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
export {
  getGlobalOmConfigPath,
  getOmConfigPath,
  loadOmConfig,
} from "./file-config";
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
  OmObserverDiagnostic,
  OmObserverDiagnosticCode,
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

interface OmRecallSourceEntry {
  id: string;
  type?: string;
  customType?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    command?: string;
    output?: string;
    customType?: string;
    summary?: string;
    display?: boolean;
    excludeFromContext?: boolean;
  };
}

interface OmResolvedObservationSources {
  renderedSources: Array<{
    id: string;
    role: string;
    text: string;
    order: number;
  }>;
  missingSourceEntryIds: string[];
}

const OM_RECENT_EVENT_LIMIT = 8;
const OM_RETRYABLE_OBSERVER_DIAGNOSTIC_CODES =
  new Set<OmObserverDiagnosticCode>([
    "missing-model",
    "auth-failed",
    "aborted",
    "provider-error",
    "empty-output",
    "invalid-output",
    "completion-error",
  ]);

const OM_DIAGNOSTIC_EVENT_CONFIG = {
  "missing-model": {
    level: "warning",
    template: (scope: string, itemLabel: string) =>
      `OM ${scope} skipped ${itemLabel}: no observer model available.`,
  },
  "auth-failed": {
    level: "warning",
    template: (scope: string, itemLabel: string) =>
      `OM ${scope} skipped ${itemLabel}: model auth unavailable.`,
  },
  aborted: {
    level: "warning",
    template: (scope: string, itemLabel: string) =>
      `OM ${scope} aborted while processing ${itemLabel}.`,
  },
  "provider-error": {
    level: "error",
    template: (scope: string, itemLabel: string) =>
      `OM ${scope} provider returned an error while processing ${itemLabel}.`,
  },
  "empty-output": {
    level: "warning",
    template: (scope: string, itemLabel: string) =>
      `OM ${scope} returned empty output for ${itemLabel}.`,
  },
  "invalid-output": {
    level: "warning",
    template: (scope: string, itemLabel: string) =>
      `OM ${scope} returned invalid JSON for ${itemLabel}.`,
  },
  "completion-error": {
    level: "error",
    template: (scope: string, itemLabel: string) =>
      `OM ${scope} failed while processing ${itemLabel}.`,
  },
  "empty-result": {
    level: "info",
    template: (scope: string, itemLabel: string) =>
      `OM ${scope} returned no durable memory for ${itemLabel}.`,
  },
} as const satisfies Partial<
  Record<
    OmObserverDiagnosticCode,
    {
      level: OmRecentEvent["level"];
      template: (scope: string, itemLabel: string) => string;
    }
  >
>;

type OmResolvedModel = NonNullable<OmLifecycleContext["model"]>;
type OmConfiguredModelStatus = "resolved" | "missing" | "ambiguous" | "none";

function listOmAvailableModels(
  modelRegistry: OmLifecycleContext["modelRegistry"]
): OmResolvedModel[] {
  return (modelRegistry.getAvailable?.() ??
    modelRegistry.getAll?.() ??
    []) as OmResolvedModel[];
}

function splitOmModelSpecifier(
  modelSpecifier: string
): { provider: string; modelId: string } | null {
  const slashIndex = modelSpecifier.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }

  return {
    provider: modelSpecifier.slice(0, slashIndex),
    modelId: modelSpecifier.slice(slashIndex + 1),
  };
}

function matchesModelSpecifier(
  model: OmResolvedModel,
  modelSpecifier: string
): boolean {
  const parts = splitOmModelSpecifier(modelSpecifier);
  if (!parts) {
    return model.id === modelSpecifier;
  }

  return model.provider === parts.provider && model.id === parts.modelId;
}

function resolveOmConfiguredModel(
  modelRegistry: OmLifecycleContext["modelRegistry"],
  modelSpecifier: string | null | undefined,
  currentModel?: OmLifecycleContext["model"]
): {
  model: OmLifecycleContext["model"];
  status: OmConfiguredModelStatus;
} {
  if (!modelSpecifier) {
    return { model: undefined, status: "none" };
  }

  if (currentModel && matchesModelSpecifier(currentModel, modelSpecifier)) {
    return { model: currentModel, status: "resolved" };
  }

  const parts = splitOmModelSpecifier(modelSpecifier);
  if (parts) {
    const resolvedModel = modelRegistry.find(parts.provider, parts.modelId);

    return {
      model: resolvedModel,
      status: resolvedModel ? "resolved" : "missing",
    };
  }

  const candidates = listOmAvailableModels(modelRegistry).filter(
    (model) => model.id === modelSpecifier
  );
  if (candidates.length === 1) {
    return { model: candidates[0], status: "resolved" };
  }

  return {
    model: undefined,
    status: candidates.length > 1 ? "ambiguous" : "missing",
  };
}

function createConfiguredModelFallbackEvent(
  updatedAt: string,
  modelSpecifier: string,
  fallback: "session-model" | "om-fallbacks",
  reason: "missing" | "ambiguous"
): OmRecentEvent {
  const suffix =
    fallback === "session-model"
      ? "falling back to the session model."
      : "falling back to OM defaults.";

  return createOmEvent({
    createdAt: updatedAt,
    level: "warning",
    message:
      reason === "ambiguous"
        ? `OM configured model ${modelSpecifier} matches multiple providers; ${suffix}`
        : `OM configured model ${modelSpecifier} is unavailable; ${suffix}`,
  });
}

function createOmObserverInvokeContext(
  modelRegistry: OmLifecycleContext["modelRegistry"],
  model: OmLifecycleContext["model"]
): Parameters<typeof invokeOmObserver>[0] {
  return { model, modelRegistry };
}

function resolveOmInvokeContext(
  ctx: OmLifecycleContext,
  configSnapshot: OmConfigSnapshot | undefined,
  updatedAt: string
): {
  invokeContext: Parameters<typeof invokeOmObserver>[0];
  fallbackEvent: OmRecentEvent | null;
} {
  const configuredModelSpecifier = configSnapshot?.model ?? null;
  const configuredModelResolution = resolveOmConfiguredModel(
    ctx.modelRegistry,
    configuredModelSpecifier,
    ctx.model
  );

  if (configuredModelResolution.model) {
    return {
      invokeContext: createOmObserverInvokeContext(
        ctx.modelRegistry,
        configuredModelResolution.model
      ),
      fallbackEvent: null,
    };
  }

  const fallbackEvent =
    configuredModelSpecifier && configuredModelResolution.status !== "none"
      ? createConfiguredModelFallbackEvent(
          updatedAt,
          configuredModelSpecifier,
          ctx.model ? "session-model" : "om-fallbacks",
          configuredModelResolution.status === "ambiguous"
            ? "ambiguous"
            : "missing"
        )
      : null;

  return {
    invokeContext: createOmObserverInvokeContext(ctx.modelRegistry, ctx.model),
    fallbackEvent,
  };
}

function createOmInvokeContext(
  ctx: OmLifecycleContext,
  configSnapshot?: OmConfigSnapshot
): Parameters<typeof invokeOmObserver>[0] {
  return resolveOmInvokeContext(ctx, configSnapshot, new Date().toISOString())
    .invokeContext;
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
  if (count === 1) {
    return `${count} ${word}`;
  }

  if (/[^aeiou]y$/i.test(word)) {
    return `${count} ${word.slice(0, -1)}ies`;
  }

  return `${count} ${word}s`;
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

function isRetryableObserverDiagnostic(
  diagnostic: OmObserverDiagnostic | null
): boolean {
  return (
    diagnostic !== null &&
    OM_RETRYABLE_OBSERVER_DIAGNOSTIC_CODES.has(diagnostic.code)
  );
}

function formatObserverDiagnosticMeta(
  diagnostic: OmObserverDiagnostic
): string {
  const meta = diagnostic.meta;
  if (!meta) {
    return "";
  }

  const parts = [
    meta.model ? `model=${meta.model}` : null,
    meta.stopReason ? `stop=${meta.stopReason}` : null,
    meta.errorMessage ? `error=${meta.errorMessage}` : null,
    typeof meta.contentPartCount === "number"
      ? `parts=${meta.contentPartCount}`
      : null,
    typeof meta.textPartCount === "number"
      ? `textParts=${meta.textPartCount}`
      : null,
    typeof meta.textCharCount === "number"
      ? `textChars=${meta.textCharCount}`
      : null,
    meta.contentTypes && meta.contentTypes.length > 0
      ? `types=${meta.contentTypes.join(",")}`
      : null,
    diagnostic.code === "invalid-output" &&
    meta.parsedTopLevelKeys &&
    meta.parsedTopLevelKeys.length > 0
      ? `keys=${meta.parsedTopLevelKeys.join(",")}`
      : null,
    diagnostic.code === "invalid-output" &&
    meta.missingTopLevelKeys &&
    meta.missingTopLevelKeys.length > 0
      ? `missing=${meta.missingTopLevelKeys.join(",")}`
      : null,
    diagnostic.code === "invalid-output" && meta.validationErrorPath
      ? `schemaPath=${meta.validationErrorPath}`
      : null,
    diagnostic.code === "invalid-output" && meta.validationErrorMessage
      ? `schemaError=${JSON.stringify(meta.validationErrorMessage)}`
      : null,
    diagnostic.code === "invalid-output" && meta.textPreview
      ? `preview=${JSON.stringify(meta.textPreview)}`
      : null,
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? ` [${parts.join(" ")}]` : "";
}

function createObserverFamilyDiagnosticEvent(input: {
  updatedAt: string;
  scope: "observer" | "observation buffer";
  itemLabel: string;
  diagnostic: OmObserverDiagnostic;
  fallbackEvent: OmRecentEvent;
}): OmRecentEvent {
  const config = OM_DIAGNOSTIC_EVENT_CONFIG[input.diagnostic.code];

  if (!config) {
    return input.fallbackEvent;
  }

  return createOmEvent({
    createdAt: input.updatedAt,
    level: config.level,
    message:
      config.template(input.scope, input.itemLabel) +
      formatObserverDiagnosticMeta(input.diagnostic),
  });
}

function createObserverDiagnosticEvent(
  updatedAt: string,
  pendingEntryCount: number,
  diagnostic: OmObserverDiagnostic
): OmRecentEvent {
  return createObserverFamilyDiagnosticEvent({
    updatedAt,
    scope: "observer",
    itemLabel: pluralize("pending entry", pendingEntryCount),
    diagnostic,
    fallbackEvent: createObserverCursorAdvanceEvent(
      updatedAt,
      pendingEntryCount
    ),
  });
}

function createObservationBufferDiagnosticEvent(
  updatedAt: string,
  sourceEntryCount: number,
  diagnostic: OmObserverDiagnostic
): OmRecentEvent {
  return createObserverFamilyDiagnosticEvent({
    updatedAt,
    scope: "observation buffer",
    itemLabel: pluralize("entry", sourceEntryCount),
    diagnostic,
    fallbackEvent: createObservationBufferEvent(updatedAt, sourceEntryCount),
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

function resolveObservationSources(
  ctx: OmRestorePlanCacheContext,
  sourceEntryIds: readonly string[]
): OmResolvedObservationSources {
  const allEntries =
    ctx.sessionManager.getEntries() as readonly OmRecallSourceEntry[];
  const branchEntryIds = ctx.sessionManager
    .getBranch()
    .map((entry) => entry.id);
  const entriesById = new Map(allEntries.map((entry) => [entry.id, entry]));
  const branchOrder = new Map(
    branchEntryIds.map((entryId, index) => [entryId, index] as const)
  );
  const renderedSources: OmResolvedObservationSources["renderedSources"] = [];
  const missingSourceEntryIds: string[] = [];
  const seenSourceEntryIds = new Set<string>();

  for (const sourceEntryId of sourceEntryIds) {
    if (!sourceEntryId || seenSourceEntryIds.has(sourceEntryId)) {
      continue;
    }

    seenSourceEntryIds.add(sourceEntryId);
    const sourceOrder = branchOrder.get(sourceEntryId);
    const sourceEntry = entriesById.get(sourceEntryId);

    if (sourceOrder === undefined || !sourceEntry) {
      missingSourceEntryIds.push(sourceEntryId);
      continue;
    }

    const serializedEntry = serializeOmObserverEntry(sourceEntry);
    if (!serializedEntry) {
      missingSourceEntryIds.push(sourceEntryId);
      continue;
    }

    renderedSources.push({
      id: sourceEntryId,
      role: serializedEntry.role,
      text: serializedEntry.text,
      order: sourceOrder,
    });
  }

  renderedSources.sort((left, right) => left.order - right.order);

  return {
    renderedSources,
    missingSourceEntryIds,
  };
}

function formatIndentedBlock(text: string, prefix = "   "): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatObservationRecallMessage(
  observation: OmStateV1["observations"][number],
  sources: OmResolvedObservationSources
): string {
  const lines = [
    `Observation ${observation.id} [${observation.kind}]`,
    `Created: ${observation.createdAt}`,
    `Summary: ${observation.summary}`,
  ];

  if (sources.renderedSources.length === 0) {
    lines.push("", "Source entries: none available.");
  } else {
    lines.push("", "Source entries:");

    for (const [index, source] of sources.renderedSources.entries()) {
      lines.push(`${index + 1}. ${source.id} [${source.role}]`);
      lines.push(formatIndentedBlock(source.text));
    }
  }

  if (sources.missingSourceEntryIds.length > 0) {
    lines.push(
      "",
      `Missing source entries: ${sources.missingSourceEntryIds.join(", ")}`
    );
  }

  return lines.join("\n");
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
      const { invokeContext, fallbackEvent } = resolveOmInvokeContext(
        ctx,
        baseState.configSnapshot,
        updatedAt
      );
      const recentEvents: OmRecentEvent[] = fallbackEvent
        ? [fallbackEvent]
        : [];

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
          let observationBufferDiagnostic: OmObserverDiagnostic | null = null;
          const bufferedObserverResult = await invokeObserverFn(
            invokeContext,
            baseState,
            observationBufferWindow,
            {
              onDiagnostic(diagnostic) {
                observationBufferDiagnostic = diagnostic;
              },
            }
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
          } else if (observationBufferDiagnostic) {
            recentEvents.push(
              createObservationBufferDiagnosticEvent(
                updatedAt,
                observationBufferWindow.pendingEntryIds.length,
                observationBufferDiagnostic
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

      let observerDiagnostic: OmObserverDiagnostic | null = null;
      const observerResult = shouldActivateObservationBuffer
        ? (
            nextRuntimeState.pendingObservationBuffer as OmObservationBufferEnvelopeV1
          ).buffer.result
        : window.status === "ready"
          ? await invokeObserverFn(invokeContext, baseState, window, {
              onDiagnostic(diagnostic) {
                observerDiagnostic = diagnostic;
              },
            })
          : createEmptyOmObserverResult();
      const shouldRetryObserverWindow =
        !shouldActivateObservationBuffer &&
        window.status === "ready" &&
        isRetryableObserverDiagnostic(observerDiagnostic);
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
        : shouldRetryObserverWindow
          ? {
              status: "noop" as const,
              reason: "observer-failed" as const,
              state: baseState,
              envelope: createOmStateEnvelope(baseState, window.branchScope),
              shouldPersist: false,
            }
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
        (observerApplied.reason === "cursor-advanced" ||
          observerApplied.reason === "observer-failed") &&
        window.pendingEntryIds.length > 0
      ) {
        recentEvents.push(
          observerDiagnostic
            ? createObserverDiagnosticEvent(
                updatedAt,
                window.pendingEntryIds.length,
                observerDiagnostic
              )
            : createObserverCursorAdvanceEvent(
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

    const recallObservation = async (
      args: string,
      ctx: OmCommandContext
    ): Promise<void> => {
      const observationId = args.trim();

      if (!observationId) {
        ctx.ui.notify("Usage: /om recall <observation-id>", "warning");
        return;
      }

      const currentRuntimeState = getRuntimeState(ctx);
      const observation = currentRuntimeState.state.observations.find(
        (candidate) => candidate.id === observationId
      );

      if (!observation) {
        ctx.ui.notify(
          currentRuntimeState.state.observations.length === 0
            ? `Observation ${observationId} not found: current branch OM has no observations.`
            : `Observation ${observationId} not found in current branch OM state.`,
          "warning"
        );
        return;
      }

      const sources = resolveObservationSources(
        ctx,
        observation.sourceEntryIds
      );
      ctx.ui.notify(
        formatObservationRecallMessage(observation, sources),
        "info"
      );
    };

    const omSubcommands = [
      {
        value: "status",
        helpLabel: "status",
        description: "Show observational memory status",
        run: async (ctx: OmCommandContext, _args: string): Promise<void> => {
          await notifyStatus(ctx);
        },
      },
      {
        value: "clear",
        helpLabel: "clear",
        description:
          "Clear persisted observational memory state for the current branch",
        run: async (ctx: OmCommandContext, _args: string): Promise<void> => {
          const clearedState = createEmptyOmState(now);
          persistRuntimeState(ctx, clearedState);
          ctx.ui.notify("Observational memory cleared.", "success");
        },
      },
      {
        value: "rebuild",
        helpLabel: "rebuild",
        description: "Rebuild observational memory from the current branch",
        run: async (ctx: OmCommandContext, _args: string): Promise<void> => {
          await rebuildState(ctx);
        },
      },
      {
        value: "recall",
        helpLabel: "recall <id>",
        description:
          "Recall the raw branch-local source entries behind an OM observation",
        run: async (ctx: OmCommandContext, args: string): Promise<void> => {
          await recallObservation(args, ctx);
        },
      },
      {
        value: "help",
        helpLabel: "help",
        description: "Show help",
        run: async (ctx: OmCommandContext, _args: string): Promise<void> => {
          ctx.ui.notify(buildOmHelpMessage(), "info");
        },
      },
    ] as const;

    function formatOmHelpLine(label: string, description: string): string {
      return `${label.padEnd(20, " ")}${description}`;
    }

    function toOmCompletionItem(subcommand: {
      value: string;
      description: string;
    }): {
      value: string;
      label: string;
      description: string;
    } {
      return {
        value: subcommand.value,
        label: subcommand.value,
        description: subcommand.description,
      };
    }

    const buildOmHelpMessage = (): string =>
      [
        "Usage: /om <command>",
        ...omSubcommands.map(({ helpLabel, description }) =>
          formatOmHelpLine(helpLabel, description)
        ),
      ].join("\n");

    const getOmArgumentCompletions = (argumentPrefix: string) => {
      const trimmedStart = argumentPrefix.trimStart();

      if (trimmedStart.length === 0) {
        return omSubcommands.map(toOmCompletionItem);
      }

      const [subcommand = "", ...rest] = trimmedStart.split(/\s+/);
      if (subcommand === "recall" && rest.length > 0) {
        return null;
      }

      const filteredSubcommands = omSubcommands.filter(({ value }) =>
        value.startsWith(subcommand)
      );

      return filteredSubcommands.length > 0
        ? filteredSubcommands.map(toOmCompletionItem)
        : null;
    };

    pi.registerCommand("om", {
      description: "Manage observational memory diagnostics and admin actions",
      getArgumentCompletions: getOmArgumentCompletions,
      handler: async (args, ctx) => {
        const [command = "help", ...rest] = args
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const commandContext = ctx as OmCommandContext;
        const subcommand = omSubcommands.find(({ value }) => value === command);

        if (!subcommand) {
          commandContext.ui.notify(
            `Unknown /om command: ${command}`,
            "warning"
          );
          commandContext.ui.notify(buildOmHelpMessage(), "info");
          return;
        }

        await subcommand.run(commandContext, rest.join(" "));
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
        createOmInvokeContext(ctx, runtimeState.state.configSnapshot),
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
