import { describe, expect, it } from "bun:test";

import { createOmBranchScope, createOmStateEnvelope } from "./branch";
import { DEFAULT_OM_CONFIG_SNAPSHOT } from "./config";
import omExtension, {
  createEmptyOmObserverResult,
  createOmExtension,
  createOmRestorePlanCache,
} from "./index";
import { createOmStatusSnapshot, formatOmStatusSummary } from "./status";
import { estimateOmObservationTokens, estimateOmTurnTokens } from "./tokens";
import type { OmStateV1 } from "./types";
import {
  OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
  OM_REFLECTION_BUFFER_CUSTOM_TYPE,
  OM_STATE_CUSTOM_TYPE,
  OM_STATE_VERSION,
} from "./version";

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

function createSessionContext(
  entries: readonly {
    id: string;
    type: string;
    customType?: string;
    data?: unknown;
  }[],
  branchEntries: readonly { id: string }[]
) {
  return {
    sessionManager: {
      getEntries() {
        return entries;
      },
      getBranch() {
        return branchEntries;
      },
    },
  };
}

function createMessageEntry(id: string, role: string, text: string) {
  return {
    id,
    type: "message" as const,
    message: {
      role,
      content: [{ type: "text", text }],
    },
  };
}

function estimateTurnBudget(
  turns: Array<{ id: string; role: string; text: string }>
): number {
  return turns.reduce(
    (totalTokens, turn) => totalTokens + estimateOmTurnTokens(turn),
    0
  );
}

function estimateObservationBudget(
  observations: Array<{
    id: string;
    kind: "fact" | "decision" | "thread" | "risk";
    summary: string;
  }>
): number {
  return observations.reduce(
    (totalTokens, observation) =>
      totalTokens +
      estimateOmObservationTokens({
        ...observation,
        sourceEntryIds: [],
        createdAt: "2026-04-04T00:00:00.000Z",
      }),
    0
  );
}

function createOmHarness(
  options?: {
    entries?: Array<{
      id: string;
      type: string;
      customType?: string;
      data?: unknown;
    }>;
    branchEntries?: Array<any>;
  },
  deps: Parameters<typeof createOmExtension>[0] = {}
) {
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  const commands = new Map<
    string,
    {
      handler: (args: string, ctx: any) => unknown;
      getArgumentCompletions?: (argumentPrefix: string) => unknown;
    }
  >();
  const entries = [...(options?.entries ?? [])];
  const branchEntries = [...(options?.branchEntries ?? [])];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level?: string }> = [];

  createOmExtension(deps)({
    on(eventName, handler) {
      handlers.set(eventName, handler as (event: unknown, ctx: any) => unknown);
    },
    registerCommand(name, definition) {
      commands.set(
        name,
        definition as { handler: (args: string, ctx: any) => unknown }
      );
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
      const entry = {
        id: `appended-${appendedEntries.length}`,
        type: "custom",
        customType,
        data,
      };
      entries.push(entry);
      branchEntries.push(entry);
    },
  } as never);

  const ctx = {
    model: undefined,
    modelRegistry: {
      find() {
        return undefined;
      },
    },
    sessionManager: {
      getEntries() {
        return entries;
      },
      getBranch() {
        return branchEntries;
      },
    },
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
  };

  return {
    entries,
    branchEntries,
    appendedEntries,
    commands,
    notifications,
    context: handlers.get("context"),
    sessionBeforeCompact: handlers.get("session_before_compact"),
    sessionStart: handlers.get("session_start"),
    turnEnd: handlers.get("turn_end"),
    ctx,
  };
}

describe("om session_start restore wiring", () => {
  it("refreshes cached restore plans using the active branch lineage", () => {
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
    const branchEntries = [
      { id: "entry-1" },
      { id: "om-inherited" },
      { id: "branch-1" },
    ] as const;

    const cache = createOmRestorePlanCache();
    const plan = cache.refreshCachedRestorePlan(
      createSessionContext(entries, branchEntries)
    );

    expect(plan).toMatchObject({
      mode: "incremental",
      reason: "cursor-found",
      sourceEntryId: "om-inherited",
      skippedCorruptEntryIds: [],
    });
    expect(cache.getCachedRestorePlan()).toEqual(plan);
  });

  it("refreshes cached rebuild plans when the latest branch snapshot is stale", () => {
    const branchEntries = [
      { id: "entry-1" },
      { id: "om-state" },
      { id: "entry-2" },
    ] as const;
    const staleEntry = {
      id: "om-state",
      type: "custom",
      customType: OM_STATE_CUSTOM_TYPE,
      data: createOmStateEnvelope(
        createSampleState({ lastProcessedEntryId: "missing-entry" }),
        createOmBranchScope(branchEntries)
      ),
    } as const;

    const cache = createOmRestorePlanCache();

    expect(
      cache.refreshCachedRestorePlan(
        createSessionContext([staleEntry], branchEntries)
      )
    ).toMatchObject({
      mode: "rebuild",
      reason: "stale-state",
      sourceEntryId: "om-state",
      skippedCorruptEntryIds: [],
      delta: {
        cursorId: "missing-entry",
        cursorFound: false,
        requiresRebuild: true,
        pendingEntries: branchEntries,
      },
    });
  });

  it("registers a session_start hook that reads session entries and branch state", () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();

    omExtension({
      on(eventName, handler) {
        handlers.set(eventName, handler);
      },
      registerCommand() {},
      appendEntry() {},
    } as never);

    const sessionStart = handlers.get("session_start");
    let getEntriesCalls = 0;
    let getBranchCalls = 0;

    sessionStart?.(
      {},
      {
        sessionManager: {
          getEntries() {
            getEntriesCalls += 1;
            return [];
          },
          getBranch() {
            getBranchCalls += 1;
            return [];
          },
        },
      }
    );

    expect(sessionStart).toBeDefined();
    expect(getEntriesCalls).toBe(1);
    expect(getBranchCalls).toBe(1);
  });

  it("applies canonical runtime token budget config over restored legacy flat aliases", async () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observation: {
            ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
            messageTokens: Number.MAX_SAFE_INTEGER,
          },
          observationMessageTokens: Number.MAX_SAFE_INTEGER,
        },
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness(
      {
        entries: [
          createMessageEntry("entry-1", "user", "Start here."),
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: persistedEnvelope,
          },
          createMessageEntry("entry-2", "assistant", "Proceed now."),
        ],
        branchEntries: [
          createMessageEntry("entry-1", "user", "Start here."),
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: persistedEnvelope,
          },
          createMessageEntry("entry-2", "assistant", "Proceed now."),
        ],
      },
      {
        config: {
          observation: {
            messageTokens: 1,
          },
        },
        invokeObserverFn: async () => createEmptyOmObserverResult(),
      } as any
    );

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      customType: OM_STATE_CUSTOM_TYPE,
      data: {
        state: {
          lastProcessedEntryId: "entry-2",
          configSnapshot: {
            observation: {
              messageTokens: 1,
              previousObserverTokens: 2000,
            },
            observationMessageTokens: 1,
            observationPreviousTokens: 2000,
          },
        },
      },
    });
  });

  it("prefers a configured OM model over ctx.model when the configured model exists", async () => {
    let usedModel: unknown;
    const configuredModel = { provider: "openai", id: "gpt-5-mini" };
    const harness = createOmHarness(
      {
        branchEntries: [
          createMessageEntry("entry-1", "user", "Start here."),
          createMessageEntry("entry-2", "assistant", "Proceed now."),
        ],
      },
      {
        config: {
          model: "openai/gpt-5-mini",
          observation: {
            messageTokens: 1,
          },
        },
        invokeObserverFn: async (invokeContext) => {
          usedModel = invokeContext.model;
          return createEmptyOmObserverResult();
        },
      } as any
    );

    const ctx = harness.ctx as any;
    ctx.model = { provider: "anthropic", id: "claude-haiku-4-5" };
    ctx.modelRegistry.find = (provider: string, modelId: string) =>
      provider === configuredModel.provider && modelId === configuredModel.id
        ? configuredModel
        : undefined;

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(usedModel).toEqual(configuredModel);
  });

  it("prefers a uniquely matched bare configured modelId over ctx.model", async () => {
    let usedModel: unknown;
    const configuredModel = { provider: "openai", id: "gpt-5-mini" };
    const harness = createOmHarness(
      {
        branchEntries: [
          createMessageEntry("entry-1", "user", "Start here."),
          createMessageEntry("entry-2", "assistant", "Proceed now."),
        ],
      },
      {
        config: {
          model: "gpt-5-mini",
          observation: {
            messageTokens: 1,
          },
        },
        invokeObserverFn: async (invokeContext) => {
          usedModel = invokeContext.model;
          return createEmptyOmObserverResult();
        },
      } as any
    );

    const ctx = harness.ctx as any;
    ctx.model = { provider: "anthropic", id: "claude-haiku-4-5" };
    ctx.modelRegistry.getAvailable = () => [configuredModel];

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(usedModel).toEqual(configuredModel);
  });

  it("falls back to ctx.model and surfaces a warning when the configured OM model is unavailable", async () => {
    let usedModel: unknown;
    const sessionModel = { provider: "anthropic", id: "claude-haiku-4-5" };
    const harness = createOmHarness(
      {
        branchEntries: [
          createMessageEntry("entry-1", "user", "Start here."),
          createMessageEntry("entry-2", "assistant", "Proceed now."),
        ],
      },
      {
        config: {
          model: "openai/gpt-5-mini",
          observation: {
            messageTokens: 1,
          },
        },
        invokeObserverFn: async (invokeContext) => {
          usedModel = invokeContext.model;
          return createEmptyOmObserverResult();
        },
      } as any
    );

    const ctx = harness.ctx as any;
    ctx.model = sessionModel;
    ctx.modelRegistry.find = () => undefined;

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(usedModel).toEqual(sessionModel);
    expect(harness.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "OM configured model openai/gpt-5-mini is unavailable; falling back to the session model.",
          level: "warning",
        }),
      ])
    );
  });

  it("falls back to ctx.model and surfaces a warning when a bare configured modelId is ambiguous", async () => {
    let usedModel: unknown;
    const sessionModel = { provider: "anthropic", id: "claude-haiku-4-5" };
    const harness = createOmHarness(
      {
        branchEntries: [
          createMessageEntry("entry-1", "user", "Start here."),
          createMessageEntry("entry-2", "assistant", "Proceed now."),
        ],
      },
      {
        config: {
          model: "gpt-5-mini",
          observation: {
            messageTokens: 1,
          },
        },
        invokeObserverFn: async (invokeContext) => {
          usedModel = invokeContext.model;
          return createEmptyOmObserverResult();
        },
      } as any
    );

    const ctx = harness.ctx as any;
    ctx.model = sessionModel;
    ctx.modelRegistry.getAvailable = () => [
      { provider: "openai", id: "gpt-5-mini" },
      { provider: "other", id: "gpt-5-mini" },
    ];

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(usedModel).toEqual(sessionModel);
    expect(harness.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "OM configured model gpt-5-mini matches multiple providers; falling back to the session model.",
          level: "warning",
        }),
      ])
    );
  });
});

describe("om context header wiring", () => {
  it("injects a hidden OM header once runtime state exists", () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        stableFacts: [
          {
            id: "fact-1",
            text: "User prefers minimal diffs.",
            sourceEntryIds: ["entry-1"],
            updatedAt: "2026-04-04T00:00:00.000Z",
          },
        ],
        activeThreads: [
          {
            id: "thread-1",
            title: "Finish OM extension",
            status: "active",
            sourceEntryIds: ["entry-2"],
            updatedAt: "2026-04-04T00:00:00.000Z",
          },
        ],
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness({
      entries: [
        { id: "entry-1", type: "message" },
        {
          id: "om-state",
          type: "custom",
          customType: OM_STATE_CUSTOM_TYPE,
          data: persistedEnvelope,
        },
      ],
      branchEntries: [
        { id: "entry-1", type: "message" },
        { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
      ],
    });

    harness.sessionStart?.({}, harness.ctx);
    const result = harness.context?.({
      messages: [{ role: "user", content: "Continue." }],
    }) as {
      messages: Array<{
        role?: string;
        customType?: string;
        content?: unknown;
      }>;
    };

    expect(result.messages[0]).toMatchObject({
      role: "custom",
      customType: "om-header",
      display: false,
    });
    expect(String(result.messages[0]?.content)).toContain(
      "User prefers minimal diffs."
    );
  });

  it("does not duplicate the injected OM header", () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        stableFacts: [
          {
            id: "fact-1",
            text: "User prefers minimal diffs.",
            sourceEntryIds: ["entry-1"],
            updatedAt: "2026-04-04T00:00:00.000Z",
          },
        ],
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness({
      entries: [
        { id: "entry-1", type: "message" },
        {
          id: "om-state",
          type: "custom",
          customType: OM_STATE_CUSTOM_TYPE,
          data: persistedEnvelope,
        },
      ],
      branchEntries: [
        { id: "entry-1", type: "message" },
        { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
      ],
    });

    harness.sessionStart?.({}, harness.ctx);
    const result = harness.context?.({
      messages: [
        {
          role: "custom",
          customType: "om-header",
          content: "[Observational Memory]",
        },
      ],
    }) as {
      messages: Array<{
        role?: string;
        customType?: string;
        content?: unknown;
      }>;
    };

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      role: "custom",
      customType: "om-header",
    });
  });
});

describe("om compaction hook wiring", () => {
  it("noops before first compaction when there is no prior summary", async () => {
    const harness = createOmHarness({
      branchEntries: [{ id: "entry-1", type: "message" }],
    });

    harness.sessionStart?.({}, harness.ctx);
    const result = await harness.sessionBeforeCompact?.(
      {
        preparation: {
          messagesToSummarize: [],
          turnPrefixMessages: [],
          tokensBefore: 42,
          firstKeptEntryId: "entry-1",
          previousSummary: "",
        },
        signal: new AbortController().signal,
      },
      harness.ctx
    );

    expect(result).toBeUndefined();
  });
});

describe("om admin commands", () => {
  it("registers grouped subcommand completions for /om", () => {
    const harness = createOmHarness();
    const command = harness.commands.get("om");

    expect(command?.getArgumentCompletions).toBeFunction();
    expect(command?.getArgumentCompletions?.("")).toEqual([
      {
        value: "status",
        label: "status",
        description: "Show observational memory status",
      },
      {
        value: "clear",
        label: "clear",
        description:
          "Clear persisted observational memory state for the current branch",
      },
      {
        value: "rebuild",
        label: "rebuild",
        description: "Rebuild observational memory from the current branch",
      },
      {
        value: "recall",
        label: "recall",
        description:
          "Recall the raw branch-local source entries behind an OM observation",
      },
      {
        value: "help",
        label: "help",
        description: "Show help",
      },
    ]);
    expect(command?.getArgumentCompletions?.("re")).toEqual([
      {
        value: "rebuild",
        label: "rebuild",
        description: "Rebuild observational memory from the current branch",
      },
      {
        value: "recall",
        label: "recall",
        description:
          "Recall the raw branch-local source entries behind an OM observation",
      },
    ]);
    expect(command?.getArgumentCompletions?.("recall ")).toBeNull();
    expect(command?.getArgumentCompletions?.("zzz")).toBeNull();
  });

  it("defaults bare /om to status", async () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        observations: [
          {
            id: "obs-1",
            kind: "fact",
            summary: "Recent note.",
            sourceEntryIds: ["entry-1"],
            createdAt: "2026-04-04T00:00:00.000Z",
          },
        ],
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness({
      entries: [
        createMessageEntry("entry-1", "user", "Start OM."),
        {
          id: "om-state",
          type: "custom",
          customType: OM_STATE_CUSTOM_TYPE,
          data: persistedEnvelope,
        },
      ],
      branchEntries: [
        createMessageEntry("entry-1", "user", "Start OM."),
        { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
      ],
    });

    harness.sessionStart?.({}, harness.ctx);
    await harness.commands.get("om")?.handler("", harness.ctx);

    expect(harness.notifications.at(-1)?.message).toContain("observations=1");
  });

  it("reports runtime counts and buffer load through /om status", async () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        observations: [
          {
            id: "obs-1",
            kind: "fact",
            summary: "Recent note.",
            sourceEntryIds: ["entry-1"],
            createdAt: "2026-04-04T00:00:00.000Z",
          },
        ],
        reflections: [
          {
            id: "refl-1",
            summary: "Older summary.",
            sourceObservationIds: ["obs-0"],
            createdAt: "2026-04-03T00:00:00.000Z",
          },
        ],
        stableFacts: [
          {
            id: "fact-1",
            text: "User prefers minimal diffs.",
            sourceEntryIds: ["entry-1"],
            updatedAt: "2026-04-04T00:00:00.000Z",
          },
        ],
        activeThreads: [
          {
            id: "thread-1",
            title: "Finish OM",
            status: "active",
            sourceEntryIds: ["entry-2"],
            updatedAt: "2026-04-04T00:00:00.000Z",
          },
        ],
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const observationBuffer = {
      version: OM_STATE_VERSION,
      branchScope: createOmBranchScope([
        { id: "entry-1" },
        { id: "om-state" },
        { id: "entry-2" },
        { id: "obs-buffer-entry" },
      ]),
      buffer: {
        id: "obs-buffer-entry",
        kind: "observation" as const,
        status: "pending" as const,
        cursorId: "entry-1",
        cursorAdvanceEntryId: "entry-2",
        sourceEntryIds: ["entry-2"],
        messageTokens: 123,
        result: createEmptyOmObserverResult(),
        createdAt: "2026-04-04T00:00:00.000Z",
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
    };
    const reflectionBuffer = {
      version: OM_STATE_VERSION,
      branchScope: {
        leafId: "entry-1",
        entryIds: [],
        lastEntryId: "entry-1",
      },
      buffer: {
        id: "refl-buffer-entry",
        kind: "reflection" as const,
        status: "pending" as const,
        sourceObservationIds: ["obs-1"],
        observationTokens: 77,
        result: { reflections: [] },
        createdAt: "2026-04-04T00:00:00.000Z",
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
    };
    const harness = createOmHarness({
      entries: [
        createMessageEntry("entry-1", "user", "Start OM."),
        {
          id: "om-state",
          type: "custom",
          customType: OM_STATE_CUSTOM_TYPE,
          data: persistedEnvelope,
        },
        createMessageEntry(
          "entry-2",
          "assistant",
          "A pending response for buffering."
        ),
        {
          id: "obs-buffer-entry",
          type: "custom",
          customType: OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
          data: { buffer: observationBuffer.buffer },
        },
        {
          id: "refl-buffer-entry",
          type: "custom",
          customType: OM_REFLECTION_BUFFER_CUSTOM_TYPE,
          data: { buffer: reflectionBuffer.buffer },
        },
      ],
      branchEntries: [
        createMessageEntry("entry-1", "user", "Start OM."),
        { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
        createMessageEntry(
          "entry-2",
          "assistant",
          "A pending response for buffering."
        ),
        {
          id: "obs-buffer-entry",
          type: "custom",
          customType: OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
        },
        {
          id: "refl-buffer-entry",
          type: "custom",
          customType: OM_REFLECTION_BUFFER_CUSTOM_TYPE,
        },
      ],
    });

    harness.sessionStart?.({}, harness.ctx);
    await harness.commands.get("om")?.handler("status", harness.ctx);

    expect(harness.notifications.at(-1)?.message).toContain("facts=1");
    expect(harness.notifications.at(-1)?.message).toContain("threads=1");
    expect(harness.notifications.at(-1)?.message).toContain("observations=1");
    expect(harness.notifications.at(-1)?.message).toContain("reflections=1");
    expect(harness.notifications.at(-1)?.message).toContain("obsBuffer=123/");
    expect(harness.notifications.at(-1)?.message).toContain("reflBuffer=77/");
  });

  it("reports recent OM activity after observer and reflector work", async () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        observations: [
          {
            id: "obs-0",
            kind: "fact",
            summary: "Older note to make reflection eligible.",
            sourceEntryIds: ["entry-1"],
            createdAt: "2026-04-04T00:00:00.000Z",
          },
        ],
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observation: {
            ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
            messageTokens: 1,
          },
          reflection: {
            ...DEFAULT_OM_CONFIG_SNAPSHOT.reflection,
            observationTokens: 1,
          },
          observationMessageTokens: 1,
          reflectionObservationTokens: 1,
        },
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness(
      {
        entries: [
          createMessageEntry("entry-1", "user", "Already processed."),
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: persistedEnvelope,
          },
          createMessageEntry("entry-2", "assistant", "Do the next thing."),
        ],
        branchEntries: [
          createMessageEntry("entry-1", "user", "Already processed."),
          { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
          createMessageEntry("entry-2", "assistant", "Do the next thing."),
        ],
      },
      {
        invokeObserverFn: async () => ({
          observations: [
            {
              kind: "decision",
              summary: "User asked for the next thing.",
            },
          ],
          stableFacts: [
            {
              id: "fact-next-step",
              text: "User wants the next action.",
            },
          ],
          activeThreads: [],
        }),
        invokeReflectorFn: async () => ({
          reflections: [
            {
              summary: "Condensed observer note.",
            },
          ],
        }),
      }
    );

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);
    await harness.commands.get("om")?.handler("status", harness.ctx);

    expect(harness.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "OM observer applied: +1 observation, +1 fact.",
          level: "success",
        }),
        expect.objectContaining({
          message: "OM reflected 1 observation into 1 reflection.",
          level: "success",
        }),
      ])
    );
    expect(harness.notifications.at(-1)?.message).toContain("events=2");
    expect(harness.notifications.at(-1)?.message).toContain(
      "lastEvent=OM reflected 1 observation into 1 reflection."
    );
  });

  it("builds a detailed status snapshot", () => {
    const branchEntries = [
      createMessageEntry("entry-1", "user", "Initial request."),
      createMessageEntry("entry-2", "assistant", "Pending follow-up."),
    ];
    const snapshot = createOmStatusSnapshot({
      state: createSampleState({
        lastProcessedEntryId: "entry-1",
        observations: [
          {
            id: "obs-1",
            kind: "fact",
            summary: "Recent note.",
            sourceEntryIds: ["entry-1"],
            createdAt: "2026-04-04T00:00:00.000Z",
          },
        ],
        reflections: [],
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observation: {
            ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
            messageTokens: 200,
            bufferTokens: 0.5,
          },
          reflection: {
            ...DEFAULT_OM_CONFIG_SNAPSHOT.reflection,
            observationTokens: 100,
            bufferActivation: 0.25,
          },
        },
      }),
      branchEntries,
      restorePlan: null,
      pendingObservationBuffer: {
        version: OM_STATE_VERSION,
        branchScope: createOmBranchScope(branchEntries),
        buffer: {
          id: "obs-buffer-1",
          kind: "observation",
          status: "pending",
          cursorId: "entry-1",
          cursorAdvanceEntryId: "entry-2",
          sourceEntryIds: ["entry-2"],
          messageTokens: 40,
          result: createEmptyOmObserverResult(),
          createdAt: "2026-04-04T00:00:00.000Z",
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      },
      pendingReflectionBuffer: {
        version: OM_STATE_VERSION,
        branchScope: {
          leafId: "entry-1",
          entryIds: [],
          lastEntryId: "entry-1",
        },
        buffer: {
          id: "refl-buffer-1",
          kind: "reflection",
          status: "pending",
          sourceObservationIds: ["obs-1"],
          observationTokens: 25,
          result: { reflections: [] },
          createdAt: "2026-04-04T00:00:00.000Z",
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      },
    });

    expect(snapshot.observer.pendingEntryCount).toBe(1);
    expect(snapshot.observer.bufferThresholdTokens).toBe(100);
    expect(snapshot.observer.bufferStatus).toBe("pending");
    expect(snapshot.reflector.bufferThresholdTokens).toBe(25);
    expect(snapshot.reflector.bufferStatus).toBe("pending");
    expect(formatOmStatusSummary(snapshot)).toContain(
      "obsBuffer=40/100 pending"
    );
    expect(formatOmStatusSummary(snapshot)).toContain(
      "reflBuffer=25/25 pending"
    );
  });

  it("clears persisted OM state through /om clear", async () => {
    const harness = createOmHarness({
      branchEntries: [{ id: "entry-1", type: "message" }],
    });

    harness.sessionStart?.({}, harness.ctx);
    await harness.commands.get("om")?.handler("clear", harness.ctx);

    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      customType: OM_STATE_CUSTOM_TYPE,
      data: {
        state: {
          observations: [],
          reflections: [],
          stableFacts: [],
          activeThreads: [],
          lastProcessedEntryId: null,
        },
      },
    });
    expect(harness.notifications.at(-1)).toEqual({
      message: "Observational memory cleared.",
      level: "success",
    });
  });

  it("rebuilds OM from the current branch through /om rebuild", async () => {
    const harness = createOmHarness(
      {
        branchEntries: [
          {
            id: "entry-1",
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "Rebuild this branch." }],
            },
          },
          {
            id: "entry-2",
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Observer can rebuild this branch now.",
                },
              ],
            },
          },
        ],
      },
      {
        invokeObserverFn: async () => ({
          observations: [
            {
              kind: "decision",
              summary: "Rebuild captured the current branch state.",
            },
          ],
          stableFacts: [],
          activeThreads: [],
        }),
      }
    );

    harness.sessionStart?.({}, harness.ctx);
    await harness.commands.get("om")?.handler("rebuild", harness.ctx);

    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      customType: OM_STATE_CUSTOM_TYPE,
      data: {
        state: {
          lastProcessedEntryId: "entry-2",
          observations: [
            expect.objectContaining({
              summary: "Rebuild captured the current branch state.",
            }),
          ],
        },
      },
    });
    expect(harness.notifications.at(-1)).toEqual({
      message: "Observational memory rebuilt.",
      level: "success",
    });
  });

  it("recalls a valid observation from current branch OM state", async () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        observations: [
          {
            id: "obs-1",
            kind: "decision",
            summary: "Add a recall command for branch-local OM sources.",
            sourceEntryIds: ["entry-1", "entry-2", "entry-3"],
            createdAt: "2026-04-04T00:02:00.000Z",
          },
        ],
      }),
      createOmBranchScope([
        { id: "entry-1" },
        { id: "entry-2" },
        { id: "entry-3" },
        { id: "om-state" },
      ])
    );
    const harness = createOmHarness({
      entries: [
        createMessageEntry("entry-1", "user", "Please add recall support."),
        createMessageEntry(
          "entry-2",
          "assistant",
          "I will inspect the OM runtime state."
        ),
        createMessageEntry(
          "entry-3",
          "toolResult",
          "Resolved raw source entries from the active branch."
        ),
        {
          id: "om-state",
          type: "custom",
          customType: OM_STATE_CUSTOM_TYPE,
          data: persistedEnvelope,
        },
      ],
      branchEntries: [
        createMessageEntry("entry-1", "user", "Please add recall support."),
        createMessageEntry(
          "entry-2",
          "assistant",
          "I will inspect the OM runtime state."
        ),
        createMessageEntry(
          "entry-3",
          "toolResult",
          "Resolved raw source entries from the active branch."
        ),
        {
          id: "om-state",
          type: "custom",
          customType: OM_STATE_CUSTOM_TYPE,
        },
      ],
    });

    harness.sessionStart?.({}, harness.ctx);
    await harness.commands.get("om")?.handler("recall obs-1", harness.ctx);

    expect(harness.notifications.at(-1)).toEqual({
      message: expect.stringContaining(
        "Observation obs-1 [decision]\nCreated: 2026-04-04T00:02:00.000Z\nSummary: Add a recall command for branch-local OM sources."
      ),
      level: "info",
    });
    expect(harness.notifications.at(-1)?.message).toContain(
      "1. entry-1 [user]\n   Please add recall support."
    );
    expect(harness.notifications.at(-1)?.message).toContain(
      "2. entry-2 [assistant]\n   I will inspect the OM runtime state."
    );
    expect(harness.notifications.at(-1)?.message).toContain(
      "3. entry-3 [toolResult]\n   Resolved raw source entries from the active branch."
    );
  });

  it("renders recalled source entries in branch chronology", async () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        observations: [
          {
            id: "obs-chronological",
            kind: "thread",
            summary: "Recall should follow branch order, not source id order.",
            sourceEntryIds: ["entry-3", "entry-1", "entry-2"],
            createdAt: "2026-04-04T00:03:00.000Z",
          },
        ],
      }),
      createOmBranchScope([
        { id: "entry-1" },
        { id: "entry-2" },
        { id: "entry-3" },
        { id: "om-state" },
      ])
    );
    const harness = createOmHarness({
      entries: [
        createMessageEntry("entry-1", "user", "First branch message."),
        createMessageEntry("entry-2", "assistant", "Second branch message."),
        createMessageEntry("entry-3", "toolResult", "Third branch message."),
        {
          id: "om-state",
          type: "custom",
          customType: OM_STATE_CUSTOM_TYPE,
          data: persistedEnvelope,
        },
      ],
      branchEntries: [
        createMessageEntry("entry-1", "user", "First branch message."),
        createMessageEntry("entry-2", "assistant", "Second branch message."),
        createMessageEntry("entry-3", "toolResult", "Third branch message."),
        {
          id: "om-state",
          type: "custom",
          customType: OM_STATE_CUSTOM_TYPE,
        },
      ],
    });

    harness.sessionStart?.({}, harness.ctx);
    await harness.commands
      .get("om")
      ?.handler("recall obs-chronological", harness.ctx);

    const recallMessage = harness.notifications.at(-1)?.message ?? "";

    expect(recallMessage.indexOf("entry-1 [user]")).toBeLessThan(
      recallMessage.indexOf("entry-2 [assistant]")
    );
    expect(recallMessage.indexOf("entry-2 [assistant]")).toBeLessThan(
      recallMessage.indexOf("entry-3 [toolResult]")
    );
  });

  it("reports when the requested observation id is missing", async () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        observations: [
          {
            id: "obs-existing",
            kind: "fact",
            summary: "Existing observation.",
            sourceEntryIds: ["entry-1"],
            createdAt: "2026-04-04T00:04:00.000Z",
          },
        ],
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness({
      entries: [
        createMessageEntry("entry-1", "user", "Existing entry."),
        {
          id: "om-state",
          type: "custom",
          customType: OM_STATE_CUSTOM_TYPE,
          data: persistedEnvelope,
        },
      ],
      branchEntries: [
        createMessageEntry("entry-1", "user", "Existing entry."),
        { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
      ],
    });

    harness.sessionStart?.({}, harness.ctx);
    await harness.commands
      .get("om")
      ?.handler("recall obs-missing", harness.ctx);

    expect(harness.notifications.at(-1)).toEqual({
      message: "Observation obs-missing not found in current branch OM state.",
      level: "warning",
    });
  });

  it("shows partial missing source entries during recall", async () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        observations: [
          {
            id: "obs-partial",
            kind: "risk",
            summary: "One source is outside the branch and one is missing.",
            sourceEntryIds: ["entry-1", "foreign-entry", "missing-entry"],
            createdAt: "2026-04-04T00:05:00.000Z",
          },
        ],
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness({
      entries: [
        createMessageEntry("entry-1", "user", "Visible branch source."),
        createMessageEntry(
          "foreign-entry",
          "assistant",
          "Other branch source."
        ),
        {
          id: "om-state",
          type: "custom",
          customType: OM_STATE_CUSTOM_TYPE,
          data: persistedEnvelope,
        },
      ],
      branchEntries: [
        createMessageEntry("entry-1", "user", "Visible branch source."),
        { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
      ],
    });

    harness.sessionStart?.({}, harness.ctx);
    await harness.commands
      .get("om")
      ?.handler("recall obs-partial", harness.ctx);

    const recallMessage = harness.notifications.at(-1)?.message ?? "";

    expect(recallMessage).toContain(
      "1. entry-1 [user]\n   Visible branch source."
    );
    expect(recallMessage).toContain(
      "Missing source entries: foreign-entry, missing-entry"
    );
  });

  it("reports empty OM state when recall runs before runtime state exists", async () => {
    const harness = createOmHarness();

    await harness.commands.get("om")?.handler("recall obs-1", harness.ctx);

    expect(harness.notifications.at(-1)).toEqual({
      message:
        "Observation obs-1 not found: current branch OM has no observations.",
      level: "warning",
    });
  });
});

describe("om turn_end observer wiring", () => {
  it("skips observer and persistence when pending turn tokens stay below the threshold", async () => {
    const pendingTurns = [
      {
        id: "entry-2",
        role: "assistant",
        text: "Tiny update.",
      },
    ];
    let observerCalls = 0;
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        lastProcessedEntryId: "entry-1",
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observationMessageTokens: estimateTurnBudget(pendingTurns) + 1,
          reflectionMinObservationCount: Number.MAX_SAFE_INTEGER,
        },
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness(
      {
        entries: [
          { id: "entry-1", type: "message" },
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: persistedEnvelope,
          },
          { id: "entry-2", type: "message" },
        ],
        branchEntries: [
          createMessageEntry("entry-1", "user", "Already processed."),
          { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
          createMessageEntry("entry-2", "assistant", "Tiny update."),
        ],
      },
      {
        invokeObserverFn: async () => {
          observerCalls += 1;
          return createEmptyOmObserverResult();
        },
      }
    );

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(observerCalls).toBe(0);
    expect(harness.appendedEntries).toHaveLength(0);
  });

  it("runs the observer once accumulated pending turn tokens cross the threshold", async () => {
    const firstPendingTurn = {
      id: "entry-2",
      role: "assistant",
      text: "First small update.",
    };
    const secondPendingTurn = {
      id: "entry-3",
      role: "user",
      text: "Second small update tips the observer over budget.",
    };
    const observationThreshold = estimateTurnBudget([
      firstPendingTurn,
      secondPendingTurn,
    ]);
    const observerWindows: Array<{
      pendingEntryIds: string[];
      newTurnIds: string[];
    }> = [];
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        lastProcessedEntryId: "entry-1",
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observationMessageTokens: observationThreshold,
          reflectionMinObservationCount: Number.MAX_SAFE_INTEGER,
        },
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness(
      {
        entries: [
          { id: "entry-1", type: "message" },
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: persistedEnvelope,
          },
          { id: "entry-2", type: "message" },
        ],
        branchEntries: [
          createMessageEntry("entry-1", "user", "Already processed."),
          { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
          createMessageEntry("entry-2", "assistant", firstPendingTurn.text),
        ],
      },
      {
        invokeObserverFn: async (_ctx, _state, window) => {
          observerWindows.push({
            pendingEntryIds: [...window.pendingEntryIds],
            newTurnIds: window.newTurns.map((turn) => turn.id),
          });
          return createEmptyOmObserverResult();
        },
      }
    );

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    harness.entries.push({ id: "entry-3", type: "message" });
    harness.branchEntries.push(
      createMessageEntry("entry-3", "user", secondPendingTurn.text)
    );
    await harness.turnEnd?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(observerWindows).toEqual([
      {
        pendingEntryIds: ["entry-2", "entry-3"],
        newTurnIds: ["entry-2", "entry-3"],
      },
    ]);
    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      data: {
        state: {
          lastProcessedEntryId: "entry-3",
        },
      },
    });
  });

  it("surfaces a missing-model diagnostic without advancing the cursor", async () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        lastProcessedEntryId: "entry-1",
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observation: {
            ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
            messageTokens: 1,
          },
          observationMessageTokens: 1,
          reflectionMinObservationCount: Number.MAX_SAFE_INTEGER,
        },
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    let observerCalls = 0;
    const harness = createOmHarness(
      {
        entries: [
          { id: "entry-1", type: "message" },
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: persistedEnvelope,
          },
          { id: "entry-2", type: "message" },
        ],
        branchEntries: [
          createMessageEntry("entry-1", "user", "Already processed."),
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
          },
          createMessageEntry(
            "entry-2",
            "assistant",
            "Threshold-crossing observer turn."
          ),
        ],
      },
      {
        invokeObserverFn: async (_ctx, _state, _window, options) => {
          observerCalls += 1;
          options?.onDiagnostic?.({ code: "missing-model" });
          return createEmptyOmObserverResult();
        },
      }
    );

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(observerCalls).toBe(2);
    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "OM observer skipped 1 pending entry: no observer model available.",
          level: "warning",
        }),
      ])
    );
  });

  it("surfaces provider error metadata when the main observer returns stop=error", async () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        lastProcessedEntryId: "entry-1",
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observation: {
            ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
            messageTokens: 1,
          },
          observationMessageTokens: 1,
          reflectionMinObservationCount: Number.MAX_SAFE_INTEGER,
        },
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness(
      {
        entries: [
          { id: "entry-1", type: "message" },
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: persistedEnvelope,
          },
          { id: "entry-2", type: "message" },
        ],
        branchEntries: [
          createMessageEntry("entry-1", "user", "Already processed."),
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
          },
          createMessageEntry(
            "entry-2",
            "assistant",
            "Threshold-crossing observer turn."
          ),
        ],
      },
      {
        invokeObserverFn: async (_ctx, _state, _window, options) => {
          options?.onDiagnostic?.({
            code: "provider-error",
            meta: {
              model: "openai-codex/gpt-5.4",
              stopReason: "error",
              errorMessage: "backend rejected codex observer request",
              contentPartCount: 0,
              textPartCount: 0,
              textCharCount: 0,
              contentTypes: [],
            },
          });
          return createEmptyOmObserverResult();
        },
      }
    );

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "OM observer provider returned an error while processing 1 pending entry. [model=openai-codex/gpt-5.4 stop=error error=backend rejected codex observer request parts=0 textParts=0 textChars=0]",
          level: "error",
        }),
      ])
    );
  });

  it("surfaces invalid JSON previews when the main observer returns prose", async () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        lastProcessedEntryId: "entry-1",
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observation: {
            ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
            messageTokens: 1,
          },
          observationMessageTokens: 1,
          reflectionMinObservationCount: Number.MAX_SAFE_INTEGER,
        },
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness(
      {
        entries: [
          { id: "entry-1", type: "message" },
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: persistedEnvelope,
          },
          { id: "entry-2", type: "message" },
        ],
        branchEntries: [
          createMessageEntry("entry-1", "user", "Already processed."),
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
          },
          createMessageEntry(
            "entry-2",
            "assistant",
            "Threshold-crossing observer turn."
          ),
        ],
      },
      {
        invokeObserverFn: async (_ctx, _state, _window, options) => {
          options?.onDiagnostic?.({
            code: "invalid-output",
            meta: {
              model: "openai-codex/gpt-5.4",
              stopReason: "stop",
              textPreview:
                "I found several useful observations and will summarize them in prose instead of strict JSON.",
              contentPartCount: 1,
              textPartCount: 1,
              textCharCount: 92,
              contentTypes: ["text"],
              validationErrorPath: "currentTask",
              validationErrorMessage:
                "Expected string length less or equal to 240",
            },
          });
          return createEmptyOmObserverResult();
        },
      }
    );

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            'OM observer returned invalid JSON for 1 pending entry. [model=openai-codex/gpt-5.4 stop=stop parts=1 textParts=1 textChars=92 types=text schemaPath=currentTask schemaError="Expected string length less or equal to 240" preview="I found several useful observations and will summarize them in prose instead of strict JSON."]',
          level: "warning",
        }),
      ])
    );
  });

  it("surfaces observer response metadata when the main observer returns empty output", async () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        lastProcessedEntryId: "entry-1",
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observation: {
            ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
            messageTokens: 1,
          },
          observationMessageTokens: 1,
          reflectionMinObservationCount: Number.MAX_SAFE_INTEGER,
        },
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness(
      {
        entries: [
          { id: "entry-1", type: "message" },
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: persistedEnvelope,
          },
          { id: "entry-2", type: "message" },
        ],
        branchEntries: [
          createMessageEntry("entry-1", "user", "Already processed."),
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
          },
          createMessageEntry(
            "entry-2",
            "assistant",
            "Threshold-crossing observer turn."
          ),
        ],
      },
      {
        invokeObserverFn: async (_ctx, _state, _window, options) => {
          options?.onDiagnostic?.({
            code: "empty-output",
            meta: {
              model: "openai/gpt-5-mini",
              stopReason: "stop",
              contentPartCount: 1,
              textPartCount: 0,
              textCharCount: 0,
              contentTypes: ["tool-call"],
            },
          });
          return createEmptyOmObserverResult();
        },
      }
    );

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "OM observer returned empty output for 1 pending entry. [model=openai/gpt-5-mini stop=stop parts=1 textParts=0 textChars=0 types=tool-call]",
          level: "warning",
        }),
      ])
    );
  });

  it("surfaces diagnostics when buffered observation precompute fails", async () => {
    const bufferedTurns = [
      {
        id: "entry-2",
        role: "assistant",
        text: "Long buffered observer turn.",
      },
      {
        id: "entry-3",
        role: "user",
        text: "Second buffered observer turn.",
      },
    ];
    const tailTurn = {
      id: "entry-4",
      role: "assistant",
      text: "Short tail turn.",
    };
    const observationThreshold =
      estimateTurnBudget([...bufferedTurns, tailTurn]) + 1;
    let observerCalls = 0;
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        lastProcessedEntryId: "entry-1",
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observation: {
            ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
            messageTokens: observationThreshold,
            bufferTokens: 0.5,
            bufferActivation: 0.5,
          },
          observationMessageTokens: observationThreshold,
          reflectionMinObservationCount: Number.MAX_SAFE_INTEGER,
        },
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness(
      {
        entries: [
          { id: "entry-1", type: "message" },
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: persistedEnvelope,
          },
          { id: "entry-2", type: "message" },
          { id: "entry-3", type: "message" },
          { id: "entry-4", type: "message" },
        ],
        branchEntries: [
          createMessageEntry("entry-1", "user", "Already processed."),
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
          },
          createMessageEntry("entry-2", "assistant", bufferedTurns[0].text),
          createMessageEntry("entry-3", "user", bufferedTurns[1].text),
          createMessageEntry("entry-4", "assistant", tailTurn.text),
        ],
      },
      {
        invokeObserverFn: async (_ctx, _state, _window, options) => {
          observerCalls += 1;
          options?.onDiagnostic?.({
            code: "empty-output",
            meta: {
              model: "openai/gpt-5-mini",
              stopReason: "stop",
              contentPartCount: 1,
              textPartCount: 0,
              textCharCount: 0,
              contentTypes: ["tool-call"],
            },
          });
          return createEmptyOmObserverResult();
        },
      }
    );

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(observerCalls).toBe(1);
    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "OM observation buffer returned empty output for 2 entries. [model=openai/gpt-5-mini stop=stop parts=1 textParts=0 textChars=0 types=tool-call]",
          level: "warning",
        }),
      ])
    );
  });

  it("persists a noop cursor advance once when non-OM custom entries are pending", async () => {
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({ lastProcessedEntryId: "entry-1" }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness({
      entries: [
        { id: "entry-1", type: "message" },
        {
          id: "om-state",
          type: "custom",
          customType: OM_STATE_CUSTOM_TYPE,
          data: persistedEnvelope,
        },
        { id: "custom-state", type: "custom", customType: "other-custom" },
      ],
      branchEntries: [
        createMessageEntry("entry-1", "user", "Already processed."),
        { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
        { id: "custom-state", type: "custom", customType: "other-custom" },
      ],
    });

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      data: {
        state: {
          lastProcessedEntryId: "custom-state",
        },
      },
    });
  });

  it("runs the reflector once the observation token threshold is crossed even below the legacy count floor", async () => {
    const entryTwoText = "Record the first observation.";
    const entryThreeText =
      "Record the second observation so reflection can start.";
    const reflectedObservationSummaries = [
      {
        id: "obs-first",
        kind: "decision" as const,
        summary: "First queued observation.",
      },
      {
        id: "obs-second",
        kind: "decision" as const,
        summary: "Second queued observation.",
      },
    ];
    let observerCalls = 0;
    let reflectorCalls = 0;
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        lastProcessedEntryId: "entry-1",
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observationMessageTokens: 1,
          reflectionMinObservationCount: 99,
          reflectionObservationTokens: estimateObservationBudget(
            reflectedObservationSummaries
          ),
        },
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const harness = createOmHarness(
      {
        entries: [
          { id: "entry-1", type: "message" },
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: persistedEnvelope,
          },
          { id: "entry-2", type: "message" },
        ],
        branchEntries: [
          createMessageEntry("entry-1", "user", "Already processed."),
          { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
          createMessageEntry("entry-2", "assistant", entryTwoText),
        ],
      },
      {
        invokeObserverFn: async (_ctx, _state, window) => {
          observerCalls += 1;
          return {
            observations: [
              {
                kind: "decision",
                summary:
                  window.cursorAdvanceEntryId === "entry-2"
                    ? reflectedObservationSummaries[0].summary
                    : reflectedObservationSummaries[1].summary,
                sourceEntryIds: [window.cursorAdvanceEntryId ?? "entry-2"],
              },
            ],
            stableFacts: [],
            activeThreads: [],
          };
        },
        invokeReflectorFn: async () => {
          reflectorCalls += 1;
          return {
            reflections: [
              {
                summary: "Compressed earlier observation history.",
                sourceObservationIds: [
                  "obs-entry-2-2026-04-04T12:00:00.000Z-1",
                ],
              },
            ],
          };
        },
        now: () => "2026-04-04T12:00:00.000Z",
      }
    );

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    harness.entries.push({ id: "entry-3", type: "message" });
    harness.branchEntries.push(
      createMessageEntry("entry-3", "user", entryThreeText)
    );
    await harness.turnEnd?.({}, harness.ctx);

    expect(observerCalls).toBe(2);
    expect(reflectorCalls).toBe(1);
    expect(harness.appendedEntries).toHaveLength(2);
    expect(harness.appendedEntries[1]).toMatchObject({
      data: {
        state: {
          lastProcessedEntryId: "entry-3",
          observations: [
            expect.objectContaining({
              summary: reflectedObservationSummaries[1].summary,
            }),
          ],
          reflections: [
            expect.objectContaining({
              summary: "Compressed earlier observation history.",
              sourceObservationIds: ["obs-entry-2-2026-04-04T12:00:00.000Z-1"],
            }),
          ],
        },
      },
    });
  });

  it("persists and activates buffered observations across restore without re-invoking the observer", async () => {
    const bufferedTurn = {
      id: "entry-2",
      role: "assistant",
      text: "Longer buffered observer update for persisted activation.",
    };
    const tailTurn = {
      id: "entry-3",
      role: "user",
      text: "Short raw tail.",
    };
    const activationTurn = {
      id: "entry-4",
      role: "assistant",
      text: "Tiny activation nudge.",
    };
    const observationThreshold =
      estimateTurnBudget([bufferedTurn, tailTurn]) + 1;
    let observerCalls = 0;
    const persistedEnvelope = createOmStateEnvelope(
      createSampleState({
        lastProcessedEntryId: "entry-1",
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observation: {
            ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
            messageTokens: observationThreshold,
            bufferTokens: 0.5,
            bufferActivation: 0.5,
          },
          observationMessageTokens: observationThreshold,
          reflectionMinObservationCount: Number.MAX_SAFE_INTEGER,
        },
      }),
      createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
    );
    const invokeObserverFn = async (
      _ctx: unknown,
      _state: unknown,
      window: any
    ) => {
      observerCalls += 1;
      return {
        observations: [
          {
            kind: "decision" as const,
            summary: `Buffered ${window.pendingEntryIds.join(",")}`,
          },
        ],
        stableFacts: [],
        activeThreads: [],
      };
    };
    const firstHarness = createOmHarness(
      {
        entries: [
          { id: "entry-1", type: "message" },
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: persistedEnvelope,
          },
          { id: "entry-2", type: "message" },
          { id: "entry-3", type: "message" },
        ],
        branchEntries: [
          createMessageEntry("entry-1", "user", "Already processed."),
          { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
          createMessageEntry("entry-2", "assistant", bufferedTurn.text),
          createMessageEntry("entry-3", "user", tailTurn.text),
        ],
      },
      {
        invokeObserverFn,
      }
    );

    firstHarness.sessionStart?.({}, firstHarness.ctx);
    await firstHarness.turnEnd?.({}, firstHarness.ctx);

    expect(observerCalls).toBe(1);
    expect(firstHarness.appendedEntries).toEqual([
      expect.objectContaining({
        customType: OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
        data: {
          buffer: expect.objectContaining({
            status: "pending",
            sourceEntryIds: ["entry-2"],
          }),
        },
      }),
    ]);

    const secondHarness = createOmHarness(
      {
        entries: [...firstHarness.entries, { id: "entry-4", type: "message" }],
        branchEntries: [
          ...firstHarness.branchEntries,
          createMessageEntry("entry-4", "assistant", activationTurn.text),
        ],
      },
      {
        invokeObserverFn,
      }
    );

    secondHarness.sessionStart?.({}, secondHarness.ctx);
    await secondHarness.turnEnd?.({}, secondHarness.ctx);

    expect(observerCalls).toBe(1);
    expect(
      secondHarness.appendedEntries.map((entry) => entry.customType)
    ).toEqual([OM_OBSERVATION_BUFFER_CUSTOM_TYPE, OM_STATE_CUSTOM_TYPE]);
    expect(secondHarness.appendedEntries[0]).toMatchObject({
      data: {
        buffer: {
          status: "activated",
          sourceEntryIds: ["entry-2"],
        },
      },
    });
    expect(secondHarness.appendedEntries[1]).toMatchObject({
      data: {
        state: {
          lastProcessedEntryId: "entry-2",
          observations: [
            expect.objectContaining({
              summary: "Buffered entry-2",
            }),
          ],
        },
      },
    });
  });

  it("persists and activates buffered reflections across restore without re-invoking the reflector", async () => {
    const baseObservations = [
      {
        id: "obs-1",
        kind: "decision" as const,
        summary: "Longer buffered reflection candidate.",
      },
      {
        id: "obs-2",
        kind: "thread" as const,
        summary: "Short live tail.",
      },
    ];
    const nextObservation = {
      id: "obs-3",
      kind: "risk" as const,
      summary: "Tiny follow-up.",
    };
    const reflectionThreshold = estimateObservationBudget(baseObservations) + 1;
    let reflectorCalls = 0;
    const baseState = createSampleState({
      observations: baseObservations.map((observation, index) => ({
        ...observation,
        sourceEntryIds: [`entry-${index + 2}`],
        createdAt: `2026-04-04T00:0${index}:00.000Z`,
      })),
      configSnapshot: {
        ...DEFAULT_OM_CONFIG_SNAPSHOT,
        observationMessageTokens: Number.MAX_SAFE_INTEGER,
        reflection: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT.reflection,
          observationTokens: reflectionThreshold,
          bufferActivation: 0.5,
        },
        reflectionObservationTokens: reflectionThreshold,
      },
    });
    const invokeReflectorFn = async () => {
      reflectorCalls += 1;
      return {
        reflections: [
          {
            summary: "Buffered reflection summary.",
            sourceObservationIds: ["obs-1"],
          },
        ],
      };
    };
    const firstHarness = createOmHarness(
      {
        entries: [
          { id: "entry-1", type: "message" },
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: createOmStateEnvelope(
              baseState,
              createOmBranchScope([{ id: "entry-1" }, { id: "om-state" }])
            ),
          },
        ],
        branchEntries: [
          createMessageEntry("entry-1", "user", "Already processed."),
          { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
        ],
      },
      {
        invokeReflectorFn,
      }
    );

    firstHarness.sessionStart?.({}, firstHarness.ctx);
    await firstHarness.turnEnd?.({}, firstHarness.ctx);

    expect(reflectorCalls).toBe(1);
    expect(firstHarness.appendedEntries).toEqual([
      expect.objectContaining({
        customType: OM_REFLECTION_BUFFER_CUSTOM_TYPE,
        data: {
          buffer: expect.objectContaining({
            status: "pending",
            sourceObservationIds: ["obs-1"],
          }),
        },
      }),
    ]);

    const restoredState = {
      ...baseState,
      observations: [
        ...baseState.observations,
        {
          ...nextObservation,
          sourceEntryIds: ["entry-4"],
          createdAt: "2026-04-04T00:03:00.000Z",
        },
      ],
      updatedAt: "2026-04-04T00:03:00.000Z",
    };
    const secondHarness = createOmHarness(
      {
        entries: [
          ...firstHarness.entries,
          {
            id: "om-state-2",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: createOmStateEnvelope(
              restoredState,
              createOmBranchScope([
                { id: "entry-1" },
                { id: "om-state" },
                { id: "appended-1" },
                { id: "om-state-2" },
              ])
            ),
          },
        ],
        branchEntries: [
          ...firstHarness.branchEntries,
          {
            id: "om-state-2",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: createOmStateEnvelope(
              restoredState,
              createOmBranchScope([
                { id: "entry-1" },
                { id: "om-state" },
                { id: "appended-1" },
                { id: "om-state-2" },
              ])
            ),
          },
        ],
      },
      {
        invokeReflectorFn,
      }
    );

    secondHarness.sessionStart?.({}, secondHarness.ctx);
    await secondHarness.turnEnd?.({}, secondHarness.ctx);

    expect(reflectorCalls).toBe(1);
    expect(
      secondHarness.appendedEntries.map((entry) => entry.customType)
    ).toEqual([OM_REFLECTION_BUFFER_CUSTOM_TYPE, OM_STATE_CUSTOM_TYPE]);
    expect(secondHarness.appendedEntries[0]).toMatchObject({
      data: {
        buffer: {
          status: "activated",
          sourceObservationIds: ["obs-1"],
        },
      },
    });
    expect(secondHarness.appendedEntries[1]).toMatchObject({
      data: {
        state: {
          reflections: [
            expect.objectContaining({
              summary: "Buffered reflection summary.",
              sourceObservationIds: ["obs-1"],
            }),
          ],
          observations: [
            expect.objectContaining({ id: "obs-2" }),
            expect.objectContaining({ id: "obs-3" }),
          ],
        },
      },
    });
  });

  it("rebuilds stale state immediately instead of waiting for the token threshold", async () => {
    let observerCalls = 0;
    const staleEnvelope = createOmStateEnvelope(
      createSampleState({
        lastProcessedEntryId: "missing-entry",
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observationMessageTokens: Number.MAX_SAFE_INTEGER,
        },
      }),
      createOmBranchScope([
        { id: "entry-1" },
        { id: "om-state" },
        { id: "entry-2" },
      ])
    );
    const harness = createOmHarness(
      {
        entries: [
          { id: "entry-1", type: "message" },
          {
            id: "om-state",
            type: "custom",
            customType: OM_STATE_CUSTOM_TYPE,
            data: staleEnvelope,
          },
          { id: "entry-2", type: "message" },
        ],
        branchEntries: [
          createMessageEntry("entry-1", "user", "Need rebuild."),
          { id: "om-state", type: "custom", customType: OM_STATE_CUSTOM_TYPE },
          createMessageEntry("entry-2", "assistant", "Still stale."),
        ],
      },
      {
        invokeObserverFn: async () => {
          observerCalls += 1;
          return createEmptyOmObserverResult();
        },
      }
    );

    harness.sessionStart?.({}, harness.ctx);
    await harness.turnEnd?.({}, harness.ctx);

    expect(observerCalls).toBe(1);
    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      data: {
        state: {
          lastProcessedEntryId: "entry-2",
          observations: [],
          reflections: [],
        },
      },
    });
  });
});
