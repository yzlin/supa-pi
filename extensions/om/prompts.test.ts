import { describe, expect, it } from "bun:test";

import { DEFAULT_OM_CONFIG_SNAPSHOT } from "./config";
import {
  createOmObserverPromptInput,
  createOmObserverWindow,
} from "./observer";
import {
  buildOmCompactionPayload,
  buildOmHeader,
  buildOmObserverPrompt,
  buildOmReflectorPrompt,
} from "./prompts";
import {
  estimateOmObservationTokens,
  estimateOmTextTokens,
  estimateOmTurnTokens,
} from "./tokens";

describe("om prompt helpers", () => {
  it("builds a bounded OM header from stable facts and active threads", () => {
    const header = buildOmHeader({
      configSnapshot: {
        ...DEFAULT_OM_CONFIG_SNAPSHOT,
        headerMaxFacts: 1,
        headerMaxThreads: 1,
      },
      stableFacts: [
        {
          id: "fact-1",
          text: "User prefers minimal diffs.",
          sourceEntryIds: ["entry-1"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
        {
          id: "fact-2",
          text: "OM stays branch-local after /fork.",
          sourceEntryIds: ["entry-2"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      activeThreads: [
        {
          id: "thread-1",
          title: "Ship OM scaffold",
          status: "active",
          summary: "Shared modules and tests.",
          sourceEntryIds: ["entry-3"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
        {
          id: "thread-2",
          title: "Implement lifecycle hooks",
          status: "waiting",
          summary: "Next task.",
          sourceEntryIds: ["entry-4"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ],
    });

    expect(header).toContain("[Observational Memory]");
    expect(header).toContain("- User prefers minimal diffs.");
    expect(header).toContain(
      "- [active] Ship OM scaffold — Shared modules and tests."
    );
    expect(header).not.toContain("branch-local after /fork");
    expect(header).not.toContain("Implement lifecycle hooks");
  });

  it("shapes observer and reflector prompts with explicit branch-local contracts", () => {
    const observerPrompt = buildOmObserverPrompt({
      branchScope: {
        leafId: "entry-4",
        entryIds: ["entry-1", "entry-2", "entry-4"],
        lastEntryId: "entry-4",
      },
      lastProcessedEntryId: "entry-2",
      previousObservations: [
        {
          id: "obs-1",
          kind: "decision",
          summary: "Keep the newest branch-local observation visible.",
          sourceEntryIds: ["entry-3"],
          createdAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      newTurns: [
        {
          id: "entry-4",
          role: "user",
          text: "Finish the OM scaffold and add tests.",
        },
      ],
      stableFacts: [
        {
          id: "fact-1",
          text: "OM is session-local.",
          sourceEntryIds: ["entry-2"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      activeThreads: [],
      configSnapshot: DEFAULT_OM_CONFIG_SNAPSHOT,
    });

    expect(observerPrompt).toContain(
      "You are the observational memory observer for pi."
    );
    expect(observerPrompt).toContain(
      "Return strict JSON only. No prose. No markdown fences."
    );
    expect(observerPrompt).toContain(
      '{"observations":[],"stableFacts":[],"activeThreads":[]}'
    );
    expect(observerPrompt).toContain(
      "observations[].kind must be one of: fact, thread, decision, risk, preference"
    );
    expect(observerPrompt).toContain(
      "activeThreads[].status must be one of: active, blocked, waiting, done"
    );
    expect(observerPrompt).toContain("leafId: entry-4");
    expect(observerPrompt).toContain("lastProcessedEntryId: entry-2");
    expect(observerPrompt).toContain("<previous_observations>");
    expect(observerPrompt).toContain(
      "[obs-1] (decision) Keep the newest branch-local observation visible."
    );
    expect(observerPrompt).toContain(
      "[entry-4] user: Finish the OM scaffold and add tests."
    );
    expect(observerPrompt).toContain("[Observational Memory]");

    const reflectorPrompt = buildOmReflectorPrompt({
      observations: [
        {
          id: "obs-1",
          kind: "decision",
          summary: "Create shared OM contract helpers before lifecycle work.",
          sourceEntryIds: ["entry-4"],
          createdAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      reflections: [
        {
          id: "refl-1",
          summary: "Prefer repo-native extensions over ad hoc scripts.",
          sourceObservationIds: ["obs-0"],
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ],
      stableFacts: [],
      activeThreads: [],
      configSnapshot: {
        ...DEFAULT_OM_CONFIG_SNAPSHOT,
        reflectionMinObservationCount: 5,
      },
    });

    expect(reflectorPrompt).toContain(
      "You are the observational memory reflector for pi."
    );
    expect(reflectorPrompt).toContain("reflectionMinObservationCount: 5");
    expect(reflectorPrompt).toContain(
      "[obs-1] (decision) Create shared OM contract helpers before lifecycle work."
    );
    expect(reflectorPrompt).toContain(
      "[refl-1] Prefer repo-native extensions over ad hoc scripts."
    );
  });

  it("renders (none) for empty observer previous observations", () => {
    const observerPrompt = buildOmObserverPrompt({
      branchScope: {
        leafId: "entry-2",
        entryIds: ["entry-1", "entry-2"],
        lastEntryId: "entry-2",
      },
      lastProcessedEntryId: "entry-1",
      previousObservations: [],
      newTurns: [],
      stableFacts: [],
      activeThreads: [],
      configSnapshot: DEFAULT_OM_CONFIG_SNAPSHOT,
    });

    expect(observerPrompt).toContain(
      "<previous_observations>\n(none)\n</previous_observations>"
    );
  });

  it("renders shared-budget observer prompts with trimmed prior observations before new turns", () => {
    const newTurns = [
      {
        id: "entry-2",
        role: "user",
        text: "Please capture the newest pending branch detail.",
      },
      {
        id: "entry-3",
        role: "assistant",
        text: "Capturing the newest pending branch detail now.",
      },
    ];
    const previousObservations = [
      {
        id: "obs-1",
        kind: "fact",
        summary: "Older observation that should be trimmed away.",
        sourceEntryIds: ["entry-1"],
        createdAt: "2026-04-04T00:00:00.000Z",
      },
      {
        id: "obs-2",
        kind: "decision",
        summary: "Newest observation that should stay visible.",
        sourceEntryIds: ["entry-2"],
        createdAt: "2026-04-04T00:01:00.000Z",
      },
    ] as const;
    const messageTokenBudget =
      newTurns.reduce(
        (totalTokens, turn) => totalTokens + estimateOmTurnTokens(turn),
        0
      ) + estimateOmObservationTokens(previousObservations[1]);
    const promptInput = createOmObserverPromptInput(
      {
        stableFacts: [],
        activeThreads: [],
        reflections: [],
        observations: [...previousObservations],
        version: "1",
        lastProcessedEntryId: "entry-1",
        updatedAt: "2026-04-04T00:02:00.000Z",
        configSnapshot: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observation: {
            ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
            messageTokens: messageTokenBudget,
            previousObserverTokens: false,
          },
          observationMessageTokens: messageTokenBudget,
          observationPreviousTokens: false,
          shareTokenBudget: true,
        },
      },
      createOmObserverWindow(
        [
          {
            id: "entry-1",
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "Already processed." }],
            },
          },
          {
            id: "entry-2",
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: newTurns[0].text }],
            },
          },
          {
            id: "entry-3",
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: newTurns[1].text }],
            },
          },
        ],
        "entry-1",
        {
          observationMessageTokens: newTurns.reduce(
            (totalTokens, turn) => totalTokens + estimateOmTurnTokens(turn),
            0
          ),
        }
      )
    );
    const observerPrompt = buildOmObserverPrompt(promptInput);

    expect(observerPrompt).toContain(
      "[obs-2] (decision) Newest observation that should stay visible."
    );
    expect(observerPrompt).not.toContain(
      "Older observation that should be trimmed away."
    );
    expect(observerPrompt).toContain(
      "[entry-2] user: Please capture the newest pending branch detail."
    );
    expect(observerPrompt).toContain(
      "[entry-3] assistant: Capturing the newest pending branch detail now."
    );
  });

  it("truncates the OM header deterministically under token pressure", () => {
    const expectedHeader = [
      "[Observational Memory]",
      "Stable facts:",
      "- Keep outputs deterministic.",
      "- Stable facts outrank active threads.",
    ].join("\n");

    const headerMaxTokens = estimateOmTextTokens(expectedHeader);

    const header = buildOmHeader({
      configSnapshot: {
        ...DEFAULT_OM_CONFIG_SNAPSHOT,
        headerMaxTokens,
        headerMaxFacts: 3,
        headerMaxThreads: 2,
      },
      stableFacts: [
        {
          id: "fact-1",
          text: "Keep outputs deterministic.",
          sourceEntryIds: ["entry-1"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
        {
          id: "fact-2",
          text: "Stable facts outrank active threads.",
          sourceEntryIds: ["entry-2"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
        {
          id: "fact-3",
          text: "This fact should be truncated by the header token budget.",
          sourceEntryIds: ["entry-3"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      activeThreads: [
        {
          id: "thread-1",
          title: "Should not appear",
          status: "active",
          summary: "Lower-priority content stays omitted once facts overflow.",
          sourceEntryIds: ["entry-4"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ],
    });

    expect(header).toBe(expectedHeader);
    expect(estimateOmTextTokens(header)).toBeLessThanOrEqual(headerMaxTokens);
    expect(header).not.toContain("Should not appear");
  });

  it("builds compaction payloads with bounded reflections and observations", () => {
    const payload = buildOmCompactionPayload({
      stableFacts: [
        {
          id: "fact-1",
          text: "OM uses a tiny stable header.",
          sourceEntryIds: ["entry-1"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      activeThreads: [
        {
          id: "thread-1",
          title: "Scaffold shared modules",
          status: "active",
          sourceEntryIds: ["entry-2"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      reflections: [
        {
          id: "refl-1",
          summary:
            "Branch-local replay must ignore entries outside the active path.",
          sourceObservationIds: ["obs-1"],
          createdAt: "2026-04-04T00:00:00.000Z",
        },
        {
          id: "refl-2",
          summary: "Hidden by config.",
          sourceObservationIds: ["obs-2"],
          createdAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      observations: [
        {
          id: "obs-1",
          kind: "fact",
          summary: "Create shared TypeBox schemas now.",
          sourceEntryIds: ["entry-2"],
          createdAt: "2026-04-04T00:00:00.000Z",
        },
        {
          id: "obs-2",
          kind: "risk",
          summary: "Hidden by config.",
          sourceEntryIds: ["entry-3"],
          createdAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      configSnapshot: {
        ...DEFAULT_OM_CONFIG_SNAPSHOT,
        compactionMaxReflections: 1,
        compactionMaxObservations: 1,
      },
    });

    expect(payload).toContain("## Observational Memory");
    expect(payload).toContain("### Stable Facts");
    expect(payload).toContain("### Active Threads");
    expect(payload).toContain("### Reflections");
    expect(payload).toContain("### Recent Observations");
    expect(payload).toContain(
      "Branch-local replay must ignore entries outside the active path."
    );
    expect(payload).toContain("Create shared TypeBox schemas now.");
    expect(payload).not.toContain("Hidden by config.");
  });

  it("truncates compaction payloads in stable section priority order", () => {
    const expectedPayload = [
      "## Observational Memory",
      "",
      "### Stable Facts",
      "- Stable facts stay first.",
      "",
      "### Active Threads",
      "- [active] Preserve section priority — Do not let lower-priority sections jump ahead.",
      "",
      "### Reflections",
      "[refl-1] Deterministic truncation matters during rollout.",
    ].join("\n");
    const compactionMaxTokens = estimateOmTextTokens(expectedPayload);

    const payload = buildOmCompactionPayload({
      stableFacts: [
        {
          id: "fact-1",
          text: "Stable facts stay first.",
          sourceEntryIds: ["entry-1"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      activeThreads: [
        {
          id: "thread-1",
          title: "Preserve section priority",
          status: "active",
          summary: "Do not let lower-priority sections jump ahead.",
          sourceEntryIds: ["entry-2"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      reflections: [
        {
          id: "refl-1",
          summary: "Deterministic truncation matters during rollout.",
          sourceObservationIds: ["obs-1"],
          createdAt: "2026-04-04T00:00:00.000Z",
        },
        {
          id: "refl-2",
          summary: "This reflection should be truncated before observations.",
          sourceObservationIds: ["obs-2"],
          createdAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      observations: [
        {
          id: "obs-1",
          kind: "risk",
          summary:
            "Recent observations stay behind reflections when truncated.",
          sourceEntryIds: ["entry-3"],
          createdAt: "2026-04-04T00:00:00.000Z",
        },
      ],
      configSnapshot: {
        ...DEFAULT_OM_CONFIG_SNAPSHOT,
        compactionMaxReflections: 2,
        compactionMaxObservations: 1,
        compactionMaxTokens,
      },
    });

    expect(payload).toBe(expectedPayload);
    expect(estimateOmTextTokens(payload)).toBeLessThanOrEqual(
      compactionMaxTokens
    );
    expect(payload).not.toContain("refl-2");
    expect(payload).not.toContain("### Recent Observations");
  });
});
