import { describe, expect, it } from "bun:test";

import {
  createOmBranchScope,
  createOmStateEnvelope,
  diffOmBranchEntriesSince,
  getLatestOmStateEnvelope,
} from "./branch";
import { createOmConfigSnapshot, DEFAULT_OM_CONFIG_SNAPSHOT } from "./config";
import { isOmStateEnvelopeV1 } from "./schema";
import type { OmStateV1 } from "./types";
import { OM_STATE_VERSION } from "./version";

const SAMPLE_STATE: OmStateV1 = {
  version: OM_STATE_VERSION,
  lastProcessedEntryId: "entry-2",
  observations: [
    {
      id: "obs-1",
      kind: "fact",
      summary: "User wants branch-local OM.",
      sourceEntryIds: ["entry-2"],
      createdAt: "2026-04-04T00:00:00.000Z",
    },
  ],
  reflections: [],
  stableFacts: [
    {
      id: "fact-1",
      text: "OM is session-local.",
      sourceEntryIds: ["entry-2"],
      updatedAt: "2026-04-04T00:00:00.000Z",
    },
  ],
  activeThreads: [
    {
      id: "thread-1",
      title: "Finish OM scaffold",
      status: "active",
      summary: "Shared contracts first.",
      sourceEntryIds: ["entry-2"],
      updatedAt: "2026-04-04T00:00:00.000Z",
    },
  ],
  configSnapshot: DEFAULT_OM_CONFIG_SNAPSHOT,
  updatedAt: "2026-04-04T00:00:00.000Z",
};

describe("om shared contracts", () => {
  it("normalizes legacy flat token budget fields into the canonical nested snapshot shape", () => {
    expect(
      createOmConfigSnapshot({
        enabled: false,
        model: "   ",
        headerMaxFacts: -5,
        headerMaxThreads: 0,
        observerMaxTurns: 3.8,
        compactionMaxObservations: Number.NaN,
        observation: {
          bufferTokens: -1,
          bufferActivation: 0,
        },
        observationMessageTokens: -1,
        observationPreviousTokens: 0,
        reflection: {
          bufferActivation: 0,
        },
        reflectionObservationTokens: 1234.8,
        headerMaxTokens: false,
        compactionMaxTokens: 1.9,
        shareTokenBudget: true,
      })
    ).toEqual({
      ...DEFAULT_OM_CONFIG_SNAPSHOT,
      enabled: false,
      model: null,
      headerMaxFacts: 1,
      headerMaxThreads: 1,
      observerMaxTurns: 3,
      observation: {
        messageTokens: 1,
        previousObserverTokens: 1,
        bufferTokens: 0.2,
        bufferActivation: 0.8,
        blockAfter: 1.2,
      },
      reflection: {
        observationTokens: 1234,
        bufferActivation: 0.5,
        blockAfter: 1.2,
      },
      observationMessageTokens: 1,
      observationPreviousTokens: 1,
      reflectionObservationTokens: 1234,
      headerMaxTokens: false,
      compactionMaxTokens: 1,
      shareTokenBudget: true,
    });
  });

  it("keeps a valid provider/modelId model override on the normalized snapshot", () => {
    expect(
      createOmConfigSnapshot({
        model: "openai/gpt-5-mini",
      })
    ).toMatchObject({
      model: "openai/gpt-5-mini",
    });
  });

  it("keeps a bare modelId override on the normalized snapshot", () => {
    expect(
      createOmConfigSnapshot({
        model: "gpt-5-mini",
      })
    ).toMatchObject({
      model: "gpt-5-mini",
    });
  });

  it("prefers canonical nested token budget fields over conflicting flat aliases", () => {
    expect(
      createOmConfigSnapshot({
        observation: {
          messageTokens: 321,
          previousObserverTokens: false,
          bufferTokens: 123,
          bufferActivation: 0.7,
          blockAfter: 1.8,
        },
        reflection: {
          observationTokens: 654,
          bufferActivation: 0.6,
          blockAfter: 2.2,
        },
        observationMessageTokens: 999,
        observationPreviousTokens: 888,
        reflectionObservationTokens: 777,
      })
    ).toMatchObject({
      observation: {
        messageTokens: 321,
        previousObserverTokens: false,
        bufferTokens: 123,
        bufferActivation: 0.7,
        blockAfter: 1.8,
      },
      reflection: {
        observationTokens: 654,
        bufferActivation: 0.6,
        blockAfter: 2.2,
      },
      observationMessageTokens: 321,
      observationPreviousTokens: false,
      reflectionObservationTokens: 654,
    });
  });

  it("builds branch scopes and incremental deltas from the current branch", () => {
    const branchEntries = [
      { id: "entry-1" },
      { id: "entry-2" },
      { id: "entry-3" },
    ];

    expect(createOmBranchScope(branchEntries, "entry-3")).toEqual({
      leafId: "entry-3",
      entryIds: ["entry-1", "entry-2", "entry-3"],
      lastEntryId: "entry-3",
    });

    expect(diffOmBranchEntriesSince(branchEntries, "entry-2")).toEqual({
      cursorId: "entry-2",
      cursorFound: true,
      requiresRebuild: false,
      pendingEntries: [{ id: "entry-3" }],
    });
  });

  it("exposes canonical nested token-budget defaults on the config snapshot contract", () => {
    expect(DEFAULT_OM_CONFIG_SNAPSHOT).toMatchObject({
      model: null,
      observation: {
        messageTokens: 12000,
        previousObserverTokens: 2000,
        bufferTokens: 0.2,
        bufferActivation: 0.8,
        blockAfter: 1.2,
      },
      reflection: {
        observationTokens: 8000,
        bufferActivation: 0.5,
        blockAfter: 1.2,
      },
      observationMessageTokens: 12000,
      observationPreviousTokens: 2000,
      reflectionObservationTokens: 8000,
      headerMaxTokens: 800,
      compactionMaxTokens: 1200,
      shareTokenBudget: false,
    });
  });

  it("flags a branch replay when the cursor is missing and restores the latest valid envelope", () => {
    const branchEntries = [
      { id: "entry-1" },
      { id: "entry-2" },
      { id: "entry-3" },
    ];
    const envelope = createOmStateEnvelope(
      SAMPLE_STATE,
      createOmBranchScope(branchEntries, "entry-3")
    );

    expect(diffOmBranchEntriesSince(branchEntries, "missing-entry")).toEqual({
      cursorId: "missing-entry",
      cursorFound: false,
      requiresRebuild: true,
      pendingEntries: branchEntries,
    });
    expect(isOmStateEnvelopeV1(envelope)).toBe(true);
    expect(
      getLatestOmStateEnvelope([
        { type: "custom", customType: "om-state", data: { nope: true } },
        { type: "custom", customType: "other", data: envelope },
        { type: "custom", customType: "om-state", data: envelope },
      ])
    ).toEqual(envelope);
  });
});
