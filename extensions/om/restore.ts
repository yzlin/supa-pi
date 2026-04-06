import { Value } from "@sinclair/typebox/value";

import { createOmBranchScope, diffOmBranchEntriesSince } from "./branch";
import { createOmConfigSnapshot, DEFAULT_OM_CONFIG_SNAPSHOT } from "./config";
import {
  OmBranchScopeSchema,
  OmObservationBufferEnvelopeV1Schema,
  OmObservationBufferSchema,
  OmReflectionBufferEnvelopeV1Schema,
  OmReflectionBufferSchema,
  OmStateV1Schema,
} from "./schema";
import type {
  OmBranchDelta,
  OmBranchScope,
  OmObservationBufferEnvelopeV1,
  OmReflectionBufferEnvelopeV1,
  OmStateEnvelopeV1,
  OmStateV1,
} from "./types";
import {
  OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
  OM_REFLECTION_BUFFER_CUSTOM_TYPE,
  OM_STATE_CUSTOM_TYPE,
  OM_STATE_VERSION,
} from "./version";

interface OmStateEntryLike {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
}

export interface OmRestoreSelection<
  TEntry extends OmStateEntryLike = OmStateEntryLike,
> {
  match: {
    entry: TEntry;
    envelope: OmStateEnvelopeV1;
  } | null;
  skippedCorruptEntryIds: string[];
}

export interface OmBufferRestoreSelection<
  TEnvelope,
  TEntry extends OmStateEntryLike = OmStateEntryLike,
> {
  match: {
    entry: TEntry;
    envelope: TEnvelope;
  } | null;
  skippedCorruptEntryIds: string[];
}

export type OmRestoreReason =
  | "cursor-found"
  | "missing-cursor"
  | "missing-state"
  | "corrupt-state"
  | "stale-state";

export interface OmRestorePlan<TEntry extends { id: string } = { id: string }> {
  mode: "incremental" | "rebuild";
  reason: OmRestoreReason;
  branchScope: OmBranchScope;
  envelope: OmStateEnvelopeV1 | null;
  sourceEntryId: string | null;
  delta: OmBranchDelta<TEntry>;
  skippedCorruptEntryIds: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asOptionalEntryId(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return asNonEmptyString(value);
}

function cloneOmBranchScope(branchScope: OmBranchScope): OmBranchScope {
  return {
    leafId: branchScope.leafId,
    entryIds: [...branchScope.entryIds],
    lastEntryId: branchScope.lastEntryId,
  };
}

function normalizeStringList(
  value: unknown,
  fallback: readonly string[] = []
): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function normalizeOmConfigSnapshot(value: unknown) {
  const config = asRecord(value);
  const observation = asRecord(config.observation);
  const reflection = asRecord(config.reflection);

  const shouldRestoreLegacyObservationMessageTokens =
    config.observationMessageTokens !== undefined &&
    observation.messageTokens !== config.observationMessageTokens &&
    (observation.messageTokens === undefined ||
      observation.messageTokens ===
        DEFAULT_OM_CONFIG_SNAPSHOT.observation.messageTokens);
  const shouldRestoreLegacyObservationPreviousTokens =
    config.observationPreviousTokens !== undefined &&
    observation.previousObserverTokens !== config.observationPreviousTokens &&
    (observation.previousObserverTokens === undefined ||
      observation.previousObserverTokens ===
        DEFAULT_OM_CONFIG_SNAPSHOT.observation.previousObserverTokens);
  const shouldRestoreLegacyReflectionObservationTokens =
    config.reflectionObservationTokens !== undefined &&
    reflection.observationTokens !== config.reflectionObservationTokens &&
    (reflection.observationTokens === undefined ||
      reflection.observationTokens ===
        DEFAULT_OM_CONFIG_SNAPSHOT.reflection.observationTokens);

  return createOmConfigSnapshot({
    ...config,
    observation: {
      ...observation,
      ...(shouldRestoreLegacyObservationMessageTokens
        ? { messageTokens: config.observationMessageTokens }
        : {}),
      ...(shouldRestoreLegacyObservationPreviousTokens
        ? { previousObserverTokens: config.observationPreviousTokens }
        : {}),
    },
    reflection: {
      ...reflection,
      ...(shouldRestoreLegacyReflectionObservationTokens
        ? { observationTokens: config.reflectionObservationTokens }
        : {}),
    },
  });
}

function normalizeOmBranchScope(
  value: unknown,
  fallbackBranchScope: OmBranchScope
): OmBranchScope {
  if (Value.Check(OmBranchScopeSchema, value)) {
    return cloneOmBranchScope(value);
  }

  const branchScope = asRecord(value);
  const entryIds = normalizeStringList(
    branchScope.entryIds,
    fallbackBranchScope.entryIds
  );

  const lastEntryId =
    asOptionalEntryId(branchScope.lastEntryId) ??
    entryIds.at(-1) ??
    fallbackBranchScope.lastEntryId;

  return {
    leafId:
      asOptionalEntryId(branchScope.leafId) ??
      fallbackBranchScope.leafId ??
      null,
    entryIds,
    lastEntryId,
  };
}

function normalizeContinuationHint(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOmState(value: unknown): OmStateV1 | null {
  if (Value.Check(OmStateV1Schema, value)) {
    const clonedState = structuredClone(value);
    const currentTask = normalizeContinuationHint(clonedState.currentTask);
    const suggestedNextResponse = normalizeContinuationHint(
      clonedState.suggestedNextResponse
    );
    const {
      currentTask: _currentTask,
      suggestedNextResponse: _suggestedNextResponse,
      ...baseState
    } = clonedState;

    return {
      ...baseState,
      ...(currentTask ? { currentTask } : {}),
      ...(suggestedNextResponse ? { suggestedNextResponse } : {}),
      configSnapshot: normalizeOmConfigSnapshot(value.configSnapshot),
    };
  }

  const record = asRecord(value);
  const updatedAt = asNonEmptyString(record.updatedAt);
  if (!updatedAt) {
    return null;
  }

  const candidate = {
    version: OM_STATE_VERSION,
    lastProcessedEntryId:
      asOptionalEntryId(record.lastProcessedEntryId) ?? null,
    observations: Array.isArray(record.observations) ? record.observations : [],
    reflections: Array.isArray(record.reflections) ? record.reflections : [],
    stableFacts: Array.isArray(record.stableFacts) ? record.stableFacts : [],
    activeThreads: Array.isArray(record.activeThreads)
      ? record.activeThreads
      : [],
    ...(normalizeContinuationHint(record.currentTask)
      ? { currentTask: normalizeContinuationHint(record.currentTask) }
      : {}),
    ...(normalizeContinuationHint(record.suggestedNextResponse)
      ? {
          suggestedNextResponse: normalizeContinuationHint(
            record.suggestedNextResponse
          ),
        }
      : {}),
    configSnapshot: normalizeOmConfigSnapshot(record.configSnapshot),
    updatedAt,
  } satisfies OmStateV1;

  return Value.Check(OmStateV1Schema, candidate) ? candidate : null;
}

export function normalizeOmStateEnvelope(
  value: unknown,
  fallbackBranchScope: OmBranchScope
): OmStateEnvelopeV1 | null {
  const envelope = asRecord(value);
  const normalizedState = normalizeOmState(envelope.state ?? value);

  if (!normalizedState) {
    return null;
  }

  return {
    version: OM_STATE_VERSION,
    branchScope: envelope.state
      ? normalizeOmBranchScope(envelope.branchScope, fallbackBranchScope)
      : cloneOmBranchScope(fallbackBranchScope),
    state: normalizedState,
  };
}

function normalizeOmObservationBufferEnvelope(
  value: unknown,
  fallbackBranchScope: OmBranchScope
): OmObservationBufferEnvelopeV1 | null {
  if (Value.Check(OmObservationBufferEnvelopeV1Schema, value)) {
    return {
      ...structuredClone(value),
      branchScope: normalizeOmBranchScope(
        value.branchScope,
        fallbackBranchScope
      ),
    };
  }

  const record = asRecord(value);
  if (!Value.Check(OmObservationBufferSchema, record.buffer)) {
    return null;
  }

  return {
    version: OM_STATE_VERSION,
    branchScope: cloneOmBranchScope(fallbackBranchScope),
    buffer: structuredClone(record.buffer),
  };
}

function normalizeOmReflectionBufferEnvelope(
  value: unknown,
  fallbackBranchScope: OmBranchScope
): OmReflectionBufferEnvelopeV1 | null {
  if (Value.Check(OmReflectionBufferEnvelopeV1Schema, value)) {
    return {
      ...structuredClone(value),
      branchScope: normalizeOmBranchScope(
        value.branchScope,
        fallbackBranchScope
      ),
    };
  }

  const record = asRecord(value);
  if (!Value.Check(OmReflectionBufferSchema, record.buffer)) {
    return null;
  }

  return {
    version: OM_STATE_VERSION,
    branchScope: cloneOmBranchScope(fallbackBranchScope),
    buffer: structuredClone(record.buffer),
  };
}

export function selectLatestOmStateEnvelopeForBranch<
  TEntry extends OmStateEntryLike,
>(
  entries: readonly TEntry[],
  branchEntries: ReadonlyArray<{ id: string }>
): OmRestoreSelection<TEntry> {
  const branchScope = createOmBranchScope(branchEntries);
  const branchEntryIds = new Set(branchScope.entryIds);
  const skippedCorruptEntryIds: string[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type !== "custom" ||
      entry.customType !== OM_STATE_CUSTOM_TYPE ||
      !branchEntryIds.has(entry.id)
    ) {
      continue;
    }

    const envelope = normalizeOmStateEnvelope(entry.data, branchScope);
    if (envelope) {
      return {
        match: {
          entry,
          envelope,
        },
        skippedCorruptEntryIds,
      };
    }

    skippedCorruptEntryIds.push(entry.id);
  }

  return {
    match: null,
    skippedCorruptEntryIds,
  };
}

function createRebuildDelta<TEntry extends { id: string }>(
  branchEntries: readonly TEntry[],
  cursorId: string | null
): OmBranchDelta<TEntry> {
  return {
    cursorId,
    cursorFound: false,
    requiresRebuild: true,
    pendingEntries: [...branchEntries],
  };
}

function selectLatestPendingOmBufferEnvelopeForBranch<
  TEnvelope extends { buffer: { id: string; status: string } },
  TEntry extends OmStateEntryLike,
>(
  entries: readonly TEntry[],
  branchEntries: ReadonlyArray<{ id: string }>,
  customType: string,
  normalizeEnvelope: (
    value: unknown,
    fallbackBranchScope: OmBranchScope
  ) => TEnvelope | null
): OmBufferRestoreSelection<TEnvelope, TEntry> {
  const branchScope = createOmBranchScope(branchEntries);
  const branchEntryIds = new Set(branchScope.entryIds);
  const skippedCorruptEntryIds: string[] = [];
  const settledBufferIds = new Set<string>();

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type !== "custom" ||
      entry.customType !== customType ||
      !branchEntryIds.has(entry.id)
    ) {
      continue;
    }

    const envelope = normalizeEnvelope(entry.data, branchScope);
    if (!envelope) {
      skippedCorruptEntryIds.push(entry.id);
      continue;
    }

    if (settledBufferIds.has(envelope.buffer.id)) {
      continue;
    }

    settledBufferIds.add(envelope.buffer.id);

    if (envelope.buffer.status !== "pending") {
      continue;
    }

    return {
      match: {
        entry,
        envelope,
      },
      skippedCorruptEntryIds,
    };
  }

  return {
    match: null,
    skippedCorruptEntryIds,
  };
}

export function selectLatestOmObservationBufferForBranch<
  TEntry extends OmStateEntryLike,
>(
  entries: readonly TEntry[],
  branchEntries: ReadonlyArray<{ id: string }>
): OmBufferRestoreSelection<OmObservationBufferEnvelopeV1, TEntry> {
  return selectLatestPendingOmBufferEnvelopeForBranch(
    entries,
    branchEntries,
    OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
    normalizeOmObservationBufferEnvelope
  );
}

export function selectLatestOmReflectionBufferForBranch<
  TEntry extends OmStateEntryLike,
>(
  entries: readonly TEntry[],
  branchEntries: ReadonlyArray<{ id: string }>
): OmBufferRestoreSelection<OmReflectionBufferEnvelopeV1, TEntry> {
  return selectLatestPendingOmBufferEnvelopeForBranch(
    entries,
    branchEntries,
    OM_REFLECTION_BUFFER_CUSTOM_TYPE,
    normalizeOmReflectionBufferEnvelope
  );
}

export function planOmStateRestore<TEntry extends { id: string }>(
  entries: readonly OmStateEntryLike[],
  branchEntries: readonly TEntry[]
): OmRestorePlan<TEntry> {
  const branchScope = createOmBranchScope(branchEntries);
  const selection = selectLatestOmStateEnvelopeForBranch(
    entries,
    branchEntries
  );

  if (!selection.match) {
    return {
      mode: "rebuild",
      reason:
        selection.skippedCorruptEntryIds.length > 0
          ? "corrupt-state"
          : "missing-state",
      branchScope,
      envelope: null,
      sourceEntryId: null,
      delta: createRebuildDelta(branchEntries, null),
      skippedCorruptEntryIds: selection.skippedCorruptEntryIds,
    };
  }

  const { entry, envelope } = selection.match;
  const { lastProcessedEntryId } = envelope.state;

  if (!lastProcessedEntryId) {
    return {
      mode: "rebuild",
      reason: "missing-cursor",
      branchScope,
      envelope,
      sourceEntryId: entry.id,
      delta: createRebuildDelta(branchEntries, null),
      skippedCorruptEntryIds: selection.skippedCorruptEntryIds,
    };
  }

  const delta = diffOmBranchEntriesSince(branchEntries, lastProcessedEntryId);
  if (delta.requiresRebuild) {
    return {
      mode: "rebuild",
      reason: "stale-state",
      branchScope,
      envelope,
      sourceEntryId: entry.id,
      delta,
      skippedCorruptEntryIds: selection.skippedCorruptEntryIds,
    };
  }

  return {
    mode: "incremental",
    reason: "cursor-found",
    branchScope,
    envelope,
    sourceEntryId: entry.id,
    delta,
    skippedCorruptEntryIds: selection.skippedCorruptEntryIds,
  };
}
