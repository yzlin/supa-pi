import { describe, expect, it } from "bun:test";

import { createOmBranchScope, createOmStateEnvelope } from "./branch";
import { DEFAULT_OM_CONFIG_SNAPSHOT } from "./config";
import {
  normalizeOmStateEnvelope,
  planOmStateRestore,
  selectLatestOmObservationBufferForBranch,
  selectLatestOmReflectionBufferForBranch,
  selectLatestOmStateEnvelopeForBranch,
} from "./restore";
import type { OmStateV1 } from "./types";
import { OM_STATE_CUSTOM_TYPE, OM_STATE_VERSION } from "./version";

function createSampleState(overrides: Partial<OmStateV1> = {}): OmStateV1 {
  return {
    version: OM_STATE_VERSION,
    lastProcessedEntryId: "entry-1",
    observations: [],
    reflections: [],
    stableFacts: [],
    activeThreads: [],
    configSnapshot: DEFAULT_OM_CONFIG_SNAPSHOT,
    updatedAt: "2026-04-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("om restore helpers", () => {
  it("selects the latest valid OM snapshot from the active branch lineage across fork inheritance and divergence", () => {
    const inheritedEnvelope = createOmStateEnvelope(
      createSampleState({ lastProcessedEntryId: "entry-1" }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-inherited" }])
    );
    const mainEnvelope = createOmStateEnvelope(
      createSampleState({ lastProcessedEntryId: "main-1" }),
      createOmBranchScope([
        { id: "entry-1" },
        { id: "om-inherited" },
        { id: "main-1" },
        { id: "om-main" },
      ])
    );
    const branchEnvelope = createOmStateEnvelope(
      createSampleState({ lastProcessedEntryId: "branch-1" }),
      createOmBranchScope([
        { id: "entry-1" },
        { id: "om-inherited" },
        { id: "branch-1" },
        { id: "om-branch" },
      ])
    );

    const entries = [
      { id: "entry-1", type: "message" },
      {
        id: "om-inherited",
        type: "custom",
        customType: OM_STATE_CUSTOM_TYPE,
        data: inheritedEnvelope,
      },
      { id: "main-1", type: "message" },
      {
        id: "om-main",
        type: "custom",
        customType: OM_STATE_CUSTOM_TYPE,
        data: mainEnvelope,
      },
      { id: "branch-1", type: "message" },
      {
        id: "om-branch",
        type: "custom",
        customType: OM_STATE_CUSTOM_TYPE,
        data: branchEnvelope,
      },
      {
        id: "om-main-newest",
        type: "custom",
        customType: OM_STATE_CUSTOM_TYPE,
        data: mainEnvelope,
      },
    ] as const;

    expect(
      selectLatestOmStateEnvelopeForBranch(entries, [
        { id: "entry-1" },
        { id: "om-inherited" },
        { id: "branch-1" },
      ]).match?.entry.id
    ).toBe("om-inherited");

    expect(
      selectLatestOmStateEnvelopeForBranch(entries, [
        { id: "entry-1" },
        { id: "om-inherited" },
        { id: "branch-1" },
        { id: "om-branch" },
      ]).match?.entry.id
    ).toBe("om-branch");
  });

  it("falls back to a full rebuild when state is missing, the cursor is missing, or the cursor is stale", () => {
    const branchEntries = [
      { id: "entry-1" },
      { id: "om-state" },
      { id: "entry-2" },
    ];

    expect(planOmStateRestore([], branchEntries)).toMatchObject({
      mode: "rebuild",
      reason: "missing-state",
      delta: {
        cursorId: null,
        cursorFound: false,
        requiresRebuild: true,
        pendingEntries: branchEntries,
      },
    });

    const cursorlessEntry = {
      id: "om-state",
      type: "custom",
      customType: OM_STATE_CUSTOM_TYPE,
      data: createOmStateEnvelope(
        createSampleState({ lastProcessedEntryId: null }),
        createOmBranchScope(branchEntries)
      ),
    } as const;

    expect(planOmStateRestore([cursorlessEntry], branchEntries)).toMatchObject({
      mode: "rebuild",
      reason: "missing-cursor",
      sourceEntryId: "om-state",
      delta: {
        cursorId: null,
        cursorFound: false,
        requiresRebuild: true,
        pendingEntries: branchEntries,
      },
    });

    const staleEntry = {
      id: "om-state",
      type: "custom",
      customType: OM_STATE_CUSTOM_TYPE,
      data: createOmStateEnvelope(
        createSampleState({ lastProcessedEntryId: "missing-entry" }),
        createOmBranchScope(branchEntries)
      ),
    } as const;

    expect(planOmStateRestore([staleEntry], branchEntries)).toMatchObject({
      mode: "rebuild",
      reason: "stale-state",
      sourceEntryId: "om-state",
      delta: {
        cursorId: "missing-entry",
        cursorFound: false,
        requiresRebuild: true,
        pendingEntries: branchEntries,
      },
    });
  });

  it("skips corrupted OM custom entries and restores the latest earlier valid snapshot", () => {
    const branchEntries = [
      { id: "entry-1" },
      { id: "om-good" },
      { id: "entry-2" },
      { id: "om-bad" },
    ];
    const goodEnvelope = createOmStateEnvelope(
      createSampleState({ lastProcessedEntryId: "entry-2" }),
      createOmBranchScope(branchEntries.slice(0, 3))
    );

    const selection = selectLatestOmStateEnvelopeForBranch(
      [
        { id: "entry-1", type: "message" },
        {
          id: "om-good",
          type: "custom",
          customType: OM_STATE_CUSTOM_TYPE,
          data: goodEnvelope,
        },
        { id: "entry-2", type: "message" },
        {
          id: "om-bad",
          type: "custom",
          customType: OM_STATE_CUSTOM_TYPE,
          data: { nope: true },
        },
      ],
      branchEntries
    );

    expect(selection.skippedCorruptEntryIds).toEqual(["om-bad"]);
    expect(selection.match?.entry.id).toBe("om-good");
    expect(selection.match?.envelope).toEqual(goodEnvelope);
  });

  it("migrates legacy state payloads into the current OM envelope shape", () => {
    const branchScope = createOmBranchScope([
      { id: "entry-1" },
      { id: "entry-2" },
    ]);

    const migrated = normalizeOmStateEnvelope(
      {
        version: 0,
        lastProcessedEntryId: "entry-1",
        observations: [],
        reflections: [],
        stableFacts: [],
        activeThreads: [],
        configSnapshot: {
          enabled: false,
          headerMaxFacts: 2,
        },
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
      branchScope
    );

    expect(migrated).toEqual({
      version: OM_STATE_VERSION,
      branchScope,
      state: {
        version: OM_STATE_VERSION,
        lastProcessedEntryId: "entry-1",
        observations: [],
        reflections: [],
        stableFacts: [],
        activeThreads: [],
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          enabled: false,
          headerMaxFacts: 2,
        },
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
    });
  });

  it("fills missing token-budget config fields when restoring legacy OM state", () => {
    const branchScope = createOmBranchScope([{ id: "entry-1" }]);

    const migrated = normalizeOmStateEnvelope(
      {
        branchScope,
        state: {
          version: OM_STATE_VERSION,
          lastProcessedEntryId: "entry-1",
          observations: [],
          reflections: [],
          stableFacts: [],
          activeThreads: [],
          configSnapshot: {
            enabled: true,
            headerMaxFacts: 3,
            headerMaxThreads: 2,
            observerMaxTurns: 4,
            compactionMaxObservations: 5,
            compactionMaxReflections: 6,
            reflectionMinObservationCount: 7,
          },
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      },
      branchScope
    );

    expect(migrated?.state.configSnapshot).toEqual({
      ...DEFAULT_OM_CONFIG_SNAPSHOT,
      headerMaxFacts: 3,
      headerMaxThreads: 2,
      observerMaxTurns: 4,
      compactionMaxObservations: 5,
      compactionMaxReflections: 6,
      reflectionMinObservationCount: 7,
    });
  });

  it("restores canonical nested token budgets and backfills legacy aliases", () => {
    const branchScope = createOmBranchScope([{ id: "entry-1" }]);

    const migrated = normalizeOmStateEnvelope(
      {
        branchScope,
        state: {
          version: OM_STATE_VERSION,
          lastProcessedEntryId: "entry-1",
          observations: [],
          reflections: [],
          stableFacts: [],
          activeThreads: [],
          configSnapshot: {
            enabled: true,
            headerMaxFacts: 3,
            headerMaxThreads: 2,
            observerMaxTurns: 4,
            compactionMaxObservations: 5,
            compactionMaxReflections: 6,
            reflectionMinObservationCount: 7,
            observation: {
              messageTokens: 321,
              previousObserverTokens: false,
              blockAfter: 1.2,
            },
            reflection: {
              observationTokens: 654,
              blockAfter: 1.2,
            },
          },
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      },
      branchScope
    );

    expect(migrated?.state.configSnapshot).toEqual({
      ...DEFAULT_OM_CONFIG_SNAPSHOT,
      headerMaxFacts: 3,
      headerMaxThreads: 2,
      observerMaxTurns: 4,
      compactionMaxObservations: 5,
      compactionMaxReflections: 6,
      reflectionMinObservationCount: 7,
      observation: {
        messageTokens: 321,
        previousObserverTokens: false,
        bufferTokens: 0.2,
        bufferActivation: 0.8,
        blockAfter: 1.2,
      },
      reflection: {
        observationTokens: 654,
        bufferActivation: 0.5,
        blockAfter: 1.2,
      },
      observationMessageTokens: 321,
      observationPreviousTokens: false,
      reflectionObservationTokens: 654,
    });
  });

  it("restores only the latest still-pending observation and reflection buffers", () => {
    const branchEntries = [
      { id: "entry-1" },
      { id: "om-state" },
      { id: "om-observation-buffer" },
      { id: "om-observation-buffer-activated" },
      { id: "om-reflection-buffer" },
    ];
    const branchScope = createOmBranchScope(branchEntries);
    const observationBuffer = {
      version: OM_STATE_VERSION,
      branchScope,
      buffer: {
        id: "obs-buffer-1",
        kind: "observation",
        status: "pending",
        cursorId: "entry-1",
        cursorAdvanceEntryId: "entry-2",
        sourceEntryIds: ["entry-2"],
        messageTokens: 12,
        result: {
          observations: [],
          stableFacts: [],
          activeThreads: [],
        },
        createdAt: "2026-04-04T00:00:00.000Z",
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
    };
    const activatedObservationBuffer = {
      ...observationBuffer,
      buffer: {
        ...observationBuffer.buffer,
        status: "activated",
        updatedAt: "2026-04-04T00:01:00.000Z",
      },
    };
    const reflectionBuffer = {
      version: OM_STATE_VERSION,
      branchScope,
      buffer: {
        id: "refl-buffer-1",
        kind: "reflection",
        status: "pending",
        sourceObservationIds: ["obs-1"],
        observationTokens: 18,
        result: {
          reflections: [{ summary: "Buffered reflection." }],
        },
        createdAt: "2026-04-04T00:02:00.000Z",
        updatedAt: "2026-04-04T00:02:00.000Z",
      },
    };

    expect(
      selectLatestOmObservationBufferForBranch(
        [
          { id: "entry-1", type: "message" },
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: createOmStateEnvelope(
              createSampleState(),
              createOmBranchScope(branchEntries.slice(0, 2))
            ),
          },
          {
            id: "om-observation-buffer",
            type: "custom",
            customType: "om-observation-buffer",
            data: observationBuffer,
          },
          {
            id: "om-observation-buffer-activated",
            type: "custom",
            customType: "om-observation-buffer",
            data: activatedObservationBuffer,
          },
          {
            id: "om-reflection-buffer",
            type: "custom",
            customType: "om-reflection-buffer",
            data: reflectionBuffer,
          },
        ],
        branchEntries
      ).match
    ).toBeNull();

    expect(
      selectLatestOmReflectionBufferForBranch(
        [
          { id: "entry-1", type: "message" },
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: createOmStateEnvelope(
              createSampleState(),
              createOmBranchScope(branchEntries.slice(0, 2))
            ),
          },
          {
            id: "om-observation-buffer",
            type: "custom",
            customType: "om-observation-buffer",
            data: observationBuffer,
          },
          {
            id: "om-observation-buffer-activated",
            type: "custom",
            customType: "om-observation-buffer",
            data: activatedObservationBuffer,
          },
          {
            id: "om-reflection-buffer",
            type: "custom",
            customType: "om-reflection-buffer",
            data: reflectionBuffer,
          },
        ],
        branchEntries
      ).match?.envelope
    ).toEqual(reflectionBuffer);
  });
});
