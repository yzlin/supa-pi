import { isOmStateEnvelopeV1 } from "./schema";
import type {
  OmBranchDelta,
  OmBranchScope,
  OmStateEnvelopeV1,
  OmStateV1,
} from "./types";
import { OM_STATE_CUSTOM_TYPE, OM_STATE_VERSION } from "./version";

export function createOmBranchScope<TEntry extends { id: string }>(
  branchEntries: readonly TEntry[],
  leafId: string | null = branchEntries.at(-1)?.id ?? null
): OmBranchScope {
  return {
    leafId,
    entryIds: branchEntries.map((entry) => entry.id),
    lastEntryId: branchEntries.at(-1)?.id ?? null,
  };
}

export function diffOmBranchEntriesSince<TEntry extends { id: string }>(
  branchEntries: readonly TEntry[],
  lastProcessedEntryId: string | null | undefined
): OmBranchDelta<TEntry> {
  if (!lastProcessedEntryId) {
    return {
      cursorId: null,
      cursorFound: true,
      requiresRebuild: false,
      pendingEntries: [...branchEntries],
    };
  }

  const cursorIndex = branchEntries.findIndex(
    (entry) => entry.id === lastProcessedEntryId
  );

  if (cursorIndex === -1) {
    return {
      cursorId: lastProcessedEntryId,
      cursorFound: false,
      requiresRebuild: true,
      pendingEntries: [...branchEntries],
    };
  }

  return {
    cursorId: lastProcessedEntryId,
    cursorFound: true,
    requiresRebuild: false,
    pendingEntries: branchEntries.slice(cursorIndex + 1),
  };
}

export function createOmStateEnvelope(
  state: OmStateV1,
  branchScope: OmBranchScope
): OmStateEnvelopeV1 {
  return {
    version: OM_STATE_VERSION,
    branchScope: {
      leafId: branchScope.leafId,
      entryIds: [...branchScope.entryIds],
      lastEntryId: branchScope.lastEntryId,
    },
    state: structuredClone(state),
  };
}

export function getLatestOmStateEnvelope(
  entries: ReadonlyArray<{
    type: string;
    customType?: string;
    data?: unknown;
  }>
): OmStateEnvelopeV1 | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== OM_STATE_CUSTOM_TYPE) {
      continue;
    }

    if (isOmStateEnvelopeV1(entry.data)) {
      return entry.data;
    }
  }

  return null;
}
