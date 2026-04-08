import { describe, expect, it } from "bun:test";

import { type AssistantMessage } from "@mariozechner/pi-ai";

import { createOmObservationBufferWindow } from "./buffer";
import { DEFAULT_OM_CONFIG_SNAPSHOT } from "./config";
import {
  applyOmObserverResult,
  buildOmObserverPromptForWindow,
  createEmptyOmObserverResult,
  createOmObserverPromptInput,
  createOmObserverWindow,
  invokeOmObserver,
  parseOmObserverResultText,
  serializeOmObserverEntry,
} from "./observer";
import { isOmObserverResult } from "./schema";
import { estimateOmObservationTokens, estimateOmTurnTokens } from "./tokens";
import type {
  OmObserverDiagnostic,
  OmObserverDiagnosticCode,
  OmObserverResult,
  OmStateV1,
} from "./types";
import { OM_STATE_VERSION } from "./version";

function createSampleState(overrides: Partial<OmStateV1> = {}): OmStateV1 {
  return {
    version: OM_STATE_VERSION,
    lastProcessedEntryId: "entry-1",
    observations: [],
    reflections: [],
    stableFacts: [
      {
        id: "fact-existing",
        text: "User prefers minimal diffs.",
        sourceEntryIds: ["entry-1"],
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
    ],
    activeThreads: [],
    configSnapshot: DEFAULT_OM_CONFIG_SNAPSHOT,
    updatedAt: "2026-04-04T00:00:00.000Z",
    ...overrides,
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

function createStructuredMessageEntry(
  id: string,
  role: string,
  content: unknown
) {
  return {
    id,
    type: "message" as const,
    message: {
      role,
      content,
    },
  };
}

function createReadyWindow(state: OmStateV1) {
  const readyTurns = [
    {
      id: "entry-2",
      role: "user",
      text: "Please capture this observer update.",
    },
    {
      id: "entry-3",
      role: "assistant",
      text: "Observer update captured.",
    },
  ];

  return createOmObserverWindow(
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
          content: [
            { type: "text", text: "Please capture this observer update." },
          ],
        },
      },
      {
        id: "entry-3",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Observer update captured." }],
        },
      },
    ],
    state.lastProcessedEntryId,
    {
      maxTurns: state.configSnapshot.observerMaxTurns,
      observationMessageTokens: estimateTurnBudget(readyTurns),
    }
  );
}

function createAssistantResponse(
  text: string,
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    ...overrides,
  } as AssistantMessage;
}

describe("om observer helpers", () => {
  it("creates an empty observer result that matches the JSON contract", () => {
    const observerResult = createEmptyOmObserverResult();

    expect(observerResult).toEqual({
      observations: [],
      stableFacts: [],
      activeThreads: [],
    });
    expect(isOmObserverResult(observerResult)).toBe(true);
    expect(createEmptyOmObserverResult()).not.toBe(observerResult);
  });

  it("parses valid observer result JSON", () => {
    const observerResultText = JSON.stringify({
      observations: [
        {
          kind: "decision",
          summary: "Track branch-local OM parser coverage.",
          sourceEntryIds: ["entry-2", "entry-3"],
        },
      ],
      stableFacts: [
        {
          id: "fact-parser",
          text: "Observer parser requires strict JSON output.",
        },
      ],
      activeThreads: [
        {
          id: "thread-parser",
          title: "Validate OM observer JSON contract",
          status: "active",
          summary: "Add focused parser tests.",
        },
      ],
    });

    const parsedResult = parseOmObserverResultText(observerResultText);

    expect(parsedResult).toEqual({
      observations: [
        {
          kind: "decision",
          summary: "Track branch-local OM parser coverage.",
          sourceEntryIds: ["entry-2", "entry-3"],
        },
      ],
      stableFacts: [
        {
          id: "fact-parser",
          text: "Observer parser requires strict JSON output.",
        },
      ],
      activeThreads: [
        {
          id: "thread-parser",
          title: "Validate OM observer JSON contract",
          status: "active",
          summary: "Add focused parser tests.",
        },
      ],
    });
    expect(isOmObserverResult(parsedResult)).toBe(true);
  });

  it("falls back to an empty observer result for invalid or empty output", () => {
    expect(parseOmObserverResultText("{not json}")).toEqual(
      createEmptyOmObserverResult()
    );
    expect(parseOmObserverResultText("   \n\t  ")).toEqual(
      createEmptyOmObserverResult()
    );
    expect(parseOmObserverResultText(null)).toEqual(
      createEmptyOmObserverResult()
    );
  });

  it("parses fenced JSON observer output", () => {
    const parsedResult = parseOmObserverResultText(`Model notes before JSON.

\`\`\`json
{
  "observations": [],
  "stableFacts": [
    {
      "id": "fact-fenced",
      "text": "Parser accepts fenced JSON blocks."
    }
  ],
  "activeThreads": []
}
\`\`\`

Trailing prose that should be ignored.`);

    expect(parsedResult).toEqual({
      observations: [],
      stableFacts: [
        {
          id: "fact-fenced",
          text: "Parser accepts fenced JSON blocks.",
        },
      ],
      activeThreads: [],
    });
    expect(isOmObserverResult(parsedResult)).toBe(true);
  });

  it("normalizes missing top-level observer arrays to empty arrays", () => {
    const parsedResult = parseOmObserverResultText(
      JSON.stringify({
        observations: [
          {
            kind: "fact",
            summary:
              "Codex omitted empty arrays but returned valid observations.",
            sourceEntryIds: ["entry-2"],
          },
        ],
      })
    );

    expect(parsedResult).toEqual({
      observations: [
        {
          kind: "fact",
          summary:
            "Codex omitted empty arrays but returned valid observations.",
          sourceEntryIds: ["entry-2"],
        },
      ],
      stableFacts: [],
      activeThreads: [],
    });
    expect(isOmObserverResult(parsedResult)).toBe(true);
  });

  it("parses double-encoded observer JSON strings", () => {
    const parsedResult = parseOmObserverResultText(
      JSON.stringify(
        JSON.stringify({
          observations: [],
          stableFacts: [
            {
              id: "fact-double-encoded",
              text: "Observer parser unwraps a JSON string payload once.",
              sourceEntryIds: ["entry-2"],
            },
          ],
          activeThreads: [],
        })
      )
    );

    expect(parsedResult).toEqual({
      observations: [],
      stableFacts: [
        {
          id: "fact-double-encoded",
          text: "Observer parser unwraps a JSON string payload once.",
          sourceEntryIds: ["entry-2"],
        },
      ],
      activeThreads: [],
    });
    expect(isOmObserverResult(parsedResult)).toBe(true);
  });

  it("serializes mixed text and attachment parts in source order", () => {
    const entry = createStructuredMessageEntry("entry-2", "user", [
      { type: "text", text: "Need this first." },
      { type: "image", filename: "wireframe.png" },
      { type: "file", path: "/tmp/spec.pdf" },
      { type: "text", text: "Need this last." },
    ]);

    expect(serializeOmObserverEntry(entry)).toEqual({
      id: "entry-2",
      role: "user",
      text: "Need this first.\n[Image: wireframe.png]\n[File: spec.pdf]\nNeed this last.",
    });
  });

  it("serializes attachment-only turns with readable placeholders", () => {
    const entry = createStructuredMessageEntry("entry-2", "assistant", [
      {
        type: "image",
        url: "https://cdn.example.com/uploads/screenshot.webp?token=abc",
      },
      { type: "file", name: "handoff.txt" },
    ]);

    expect(serializeOmObserverEntry(entry)).toEqual({
      id: "entry-2",
      role: "assistant",
      text: "[Image: screenshot.webp]\n[File: handoff.txt]",
    });
  });

  it("ignores unsupported and noisy parts while keeping readable placeholders", () => {
    const entry = createStructuredMessageEntry("entry-2", "user", [
      { type: "reasoning", text: "ignore this" },
      { type: "text", text: " Keep this. " },
      { type: "image", path: "/tmp/architecture.svg?cache=1" },
      { type: "text", text: "   " },
      { type: "metadata", value: { noisy: true } },
      { type: "file", fileName: "notes.md" },
      null,
      { type: "unknown" },
    ]);

    expect(serializeOmObserverEntry(entry)).toEqual({
      id: "entry-2",
      role: "user",
      text: "Keep this.\n[Image: architecture.svg]\n[File: notes.md]",
    });
  });

  it("keeps placeholder-bearing turns intact when observation buffering slices the branch tail", () => {
    const placeholderEntry = createStructuredMessageEntry("entry-2", "user", [
      { type: "text", text: "Keep this." },
      { type: "image", filename: "architecture.svg" },
      { type: "file", filename: "notes.md" },
    ]);
    const tailTurn = {
      id: "entry-3",
      role: "assistant",
      text: "Newest turn stays in the live observer window.",
    };
    const tailTurnTokens = estimateOmTurnTokens(tailTurn);

    expect(
      createOmObservationBufferWindow(
        [
          createMessageEntry("entry-1", "assistant", "Already processed."),
          placeholderEntry,
          createMessageEntry("entry-3", "assistant", tailTurn.text),
        ],
        "entry-1",
        {
          ...DEFAULT_OM_CONFIG_SNAPSHOT,
          observation: {
            ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
            messageTokens: tailTurnTokens,
            bufferTokens: 1,
            bufferActivation: 0,
          },
          observationMessageTokens: tailTurnTokens,
        }
      )
    ).toMatchObject({
      status: "ready",
      pendingEntryIds: ["entry-2"],
      cursorAdvanceEntryId: "entry-2",
      newTurns: [
        {
          id: "entry-2",
          role: "user",
          text: "Keep this.\n[Image: architecture.svg]\n[File: notes.md]",
        },
      ],
    });
  });

  it("returns threshold-not-met until pending serialized turns cross the token threshold", () => {
    const turns = [
      {
        id: "entry-2",
        role: "user",
        text: "Short observer update.",
      },
      {
        id: "entry-3",
        role: "assistant",
        text: "Short observer acknowledgment.",
      },
    ];
    const window = createOmObserverWindow(
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
            content: [{ type: "text", text: "Short observer update." }],
          },
        },
        {
          id: "entry-3",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Short observer acknowledgment." }],
          },
        },
      ],
      "entry-1",
      {
        observationMessageTokens: estimateTurnBudget(turns) + 1,
      }
    );

    expect(window).toMatchObject({
      status: "noop",
      reason: "threshold-not-met",
      pendingEntryIds: ["entry-2", "entry-3"],
      newTurns: [],
      cursorAdvanceEntryId: null,
    });
  });

  it("keeps the full pending message window once branch message tokens cross the threshold", () => {
    const turns = [
      {
        id: "entry-2",
        role: "assistant",
        text: "Older observer detail.",
      },
      {
        id: "entry-3",
        role: "user",
        text: "Newest important user turn.",
      },
      {
        id: "entry-4",
        role: "assistant",
        text: "Newest important assistant turn.",
      },
    ];
    const window = createOmObserverWindow(
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
            role: "assistant",
            content: [{ type: "text", text: "Older observer detail." }],
          },
        },
        {
          id: "entry-3",
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Newest important user turn." }],
          },
        },
        {
          id: "entry-4",
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Newest important assistant turn." },
            ],
          },
        },
      ],
      "entry-1",
      {
        observationMessageTokens: estimateTurnBudget(turns.slice(1)),
      }
    );

    expect(window).toMatchObject({
      status: "ready",
      reason: "new-turns",
      pendingEntryIds: ["entry-2", "entry-3", "entry-4"],
      cursorAdvanceEntryId: "entry-4",
      newTurns: turns,
    });
  });

  it("applies observerMaxTurns after token selection", () => {
    const state = createSampleState({
      configSnapshot: {
        ...DEFAULT_OM_CONFIG_SNAPSHOT,
        observerMaxTurns: 2,
      },
    });
    const branchEntries = [
      {
        id: "entry-1",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Old context." }],
        },
      },
      { id: "om-state", type: "custom", customType: "om-state" },
      {
        id: "entry-2",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Ignored by maxTurns." }],
        },
      },
      {
        id: "entry-3",
        type: "message",
        message: {
          role: "custom",
          display: false,
          content: [{ type: "text", text: "Hidden custom entry." }],
        },
      },
      {
        id: "entry-4",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Finish observer helpers." }],
        },
      },
      {
        id: "entry-5",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Adding focused tests now." }],
        },
      },
    ] as const;
    const window = createOmObserverWindow(
      branchEntries,
      state.lastProcessedEntryId,
      {
        maxTurns: state.configSnapshot.observerMaxTurns,
        observationMessageTokens: estimateTurnBudget([
          {
            id: "entry-2",
            role: "assistant",
            text: "Ignored by maxTurns.",
          },
          {
            id: "entry-4",
            role: "user",
            text: "Finish observer helpers.",
          },
          {
            id: "entry-5",
            role: "assistant",
            text: "Adding focused tests now.",
          },
        ]),
      }
    );

    expect(window).toMatchObject({
      status: "ready",
      reason: "new-turns",
      pendingEntryIds: ["entry-2", "entry-3", "entry-4", "entry-5"],
      cursorAdvanceEntryId: "entry-5",
      newTurns: [
        {
          id: "entry-4",
          role: "user",
          text: "Finish observer helpers.",
        },
        {
          id: "entry-5",
          role: "assistant",
          text: "Adding focused tests now.",
        },
      ],
    });

    const promptInput = createOmObserverPromptInput(state, window);
    expect(promptInput).toEqual({
      branchScope: window.branchScope,
      lastProcessedEntryId: "entry-1",
      previousObservations: [],
      newTurns: window.newTurns,
      stableFacts: state.stableFacts,
      activeThreads: state.activeThreads,
      configSnapshot: state.configSnapshot,
    });

    const prompt = buildOmObserverPromptForWindow(state, window);
    expect(prompt).toContain("leafId: entry-5");
    expect(prompt).toContain("lastProcessedEntryId: entry-1");
    expect(prompt).toContain(
      "<previous_observations>\n(none)\n</previous_observations>"
    );
    expect(prompt).toContain("[entry-4] user: Finish observer helpers.");
    expect(prompt).toContain("[entry-5] assistant: Adding focused tests now.");
    expect(prompt).not.toContain("Ignored by maxTurns.");
  });

  it("trims previous observations to the newest entries within the configured token budget", () => {
    const observations = [
      {
        id: "obs-1",
        kind: "fact",
        summary: "Older observation that should be trimmed.",
        sourceEntryIds: ["entry-1"],
        createdAt: "2026-04-04T00:00:00.000Z",
      },
      {
        id: "obs-2",
        kind: "decision",
        summary: "Newer observation that should stay.",
        sourceEntryIds: ["entry-2"],
        createdAt: "2026-04-04T00:01:00.000Z",
      },
      {
        id: "obs-3",
        kind: "risk",
        summary: "Newest observation that should also stay.",
        sourceEntryIds: ["entry-3"],
        createdAt: "2026-04-04T00:02:00.000Z",
      },
    ] as const;
    const state = createSampleState({
      observations: [...observations],
      configSnapshot: {
        ...DEFAULT_OM_CONFIG_SNAPSHOT,
        observation: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
          previousObserverTokens:
            estimateOmObservationTokens(observations[1]) +
            estimateOmObservationTokens(observations[2]),
        },
        observationPreviousTokens:
          estimateOmObservationTokens(observations[1]) +
          estimateOmObservationTokens(observations[2]),
      },
    });

    const promptInput = createOmObserverPromptInput(
      state,
      createReadyWindow(state)
    );

    expect(promptInput.previousObservations).toEqual([
      observations[1],
      observations[2],
    ]);
  });

  it("keeps previous observations untrimmed when observation.previousObserverTokens is false", () => {
    const observations = [
      {
        id: "obs-1",
        kind: "fact",
        summary: "Keep the full previous observation history.",
        sourceEntryIds: ["entry-1"],
        createdAt: "2026-04-04T00:00:00.000Z",
      },
      {
        id: "obs-2",
        kind: "thread",
        summary: "Do not trim when the config disables the budget.",
        sourceEntryIds: ["entry-2"],
        createdAt: "2026-04-04T00:01:00.000Z",
      },
    ];
    const state = createSampleState({
      observations,
      configSnapshot: {
        ...DEFAULT_OM_CONFIG_SNAPSHOT,
        observation: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
          previousObserverTokens: false,
        },
        observationPreviousTokens: false,
      },
    });

    const promptInput = createOmObserverPromptInput(
      state,
      createReadyWindow(state)
    );

    expect(promptInput.previousObservations).toEqual(observations);
  });

  it("shrinks previous observations before cutting new message history when shareTokenBudget is enabled", () => {
    const observations = [
      {
        id: "obs-1",
        kind: "fact",
        summary: "Older observation trimmed by the shared budget.",
        sourceEntryIds: ["entry-1"],
        createdAt: "2026-04-04T00:00:00.000Z",
      },
      {
        id: "obs-2",
        kind: "decision",
        summary: "Newest observation kept after budgeting.",
        sourceEntryIds: ["entry-2"],
        createdAt: "2026-04-04T00:01:00.000Z",
      },
    ] as const;
    const readyWindow = createReadyWindow(createSampleState());
    const newestObservationBudget = estimateOmObservationTokens(
      observations[1]
    );
    const state = createSampleState({
      observations: [...observations],
      configSnapshot: {
        ...DEFAULT_OM_CONFIG_SNAPSHOT,
        observation: {
          ...DEFAULT_OM_CONFIG_SNAPSHOT.observation,
          messageTokens:
            estimateTurnBudget(readyWindow.newTurns) + newestObservationBudget,
          previousObserverTokens: false,
        },
        observationMessageTokens:
          estimateTurnBudget(readyWindow.newTurns) + newestObservationBudget,
        observationPreviousTokens: false,
        shareTokenBudget: true,
      },
    });

    const promptInput = createOmObserverPromptInput(state, readyWindow);

    expect(promptInput.newTurns).toEqual(readyWindow.newTurns);
    expect(promptInput.previousObservations).toEqual([observations[1]]);
  });

  it("marks observer windows as block-after once pending message load exceeds the safety ratio", () => {
    const turns = [
      {
        id: "entry-2",
        role: "user",
        text: "Block after should force synchronous observation once the pending branch window grows too large.",
      },
      {
        id: "entry-3",
        role: "assistant",
        text: "The observer should still include the full pending window rather than trimming it to the threshold.",
      },
    ];
    const window = createOmObserverWindow(
      [
        createMessageEntry("entry-1", "user", "Already processed."),
        createMessageEntry("entry-2", "user", turns[0].text),
        createMessageEntry("entry-3", "assistant", turns[1].text),
      ],
      "entry-1",
      {
        observationMessageTokens: estimateTurnBudget(turns) - 1,
        blockAfter: 1,
      }
    );

    expect(window).toMatchObject({
      status: "ready",
      reason: "block-after",
      newTurns: turns,
      cursorAdvanceEntryId: "entry-3",
    });
  });

  it("keeps skipping om-state entries during token-gated selection", () => {
    const turns = [
      {
        id: "entry-2",
        role: "user",
        text: "Observe the real user turn.",
      },
      {
        id: "entry-3",
        role: "assistant",
        text: "Observe the real assistant turn.",
      },
    ];
    const window = createOmObserverWindow(
      [
        {
          id: "entry-1",
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Already processed." }],
          },
        },
        { id: "om-state", type: "custom", customType: "om-state" },
        {
          id: "entry-2",
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Observe the real user turn." }],
          },
        },
        {
          id: "entry-3",
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Observe the real assistant turn." },
            ],
          },
        },
      ],
      "entry-1",
      {
        observationMessageTokens: estimateTurnBudget(turns),
      }
    );

    expect(window).toMatchObject({
      status: "ready",
      reason: "new-turns",
      pendingEntryIds: ["entry-2", "entry-3"],
      cursorAdvanceEntryId: "entry-3",
      newTurns: [
        {
          id: "entry-2",
          role: "user",
          text: "Observe the real user turn.",
        },
        {
          id: "entry-3",
          role: "assistant",
          text: "Observe the real assistant turn.",
        },
      ],
    });
  });

  it("returns duplicate windows for OM state entries and noop windows for other custom entries", () => {
    const duplicateOmStateWindow = createOmObserverWindow(
      [
        {
          id: "entry-1",
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Already processed." }],
          },
        },
        { id: "om-state", type: "custom", customType: "om-state" },
      ],
      "entry-1"
    );

    expect(duplicateOmStateWindow).toMatchObject({
      status: "duplicate",
      reason: "no-new-entries",
      pendingEntryIds: [],
      newTurns: [],
      cursorAdvanceEntryId: null,
    });

    const noopWindow = createOmObserverWindow(
      [
        {
          id: "entry-1",
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Already processed." }],
          },
        },
        { id: "custom-state", type: "custom", customType: "other-custom" },
      ],
      "entry-1"
    );

    expect(noopWindow).toMatchObject({
      status: "noop",
      reason: "no-completed-turns",
      pendingEntryIds: ["custom-state"],
      newTurns: [],
      cursorAdvanceEntryId: "custom-state",
    });

    const duplicateWindow = createOmObserverWindow(
      [
        {
          id: "entry-1",
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Already processed." }],
          },
        },
      ],
      "entry-1"
    );

    expect(duplicateWindow).toMatchObject({
      status: "duplicate",
      reason: "no-new-entries",
      pendingEntryIds: [],
      newTurns: [],
      cursorAdvanceEntryId: null,
    });
  });

  it("returns a rebuild window when the incremental cursor is missing from the branch", () => {
    const branchEntries = [
      {
        id: "entry-1",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Entry one." }],
        },
      },
      {
        id: "entry-2",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Entry two." }],
        },
      },
    ] as const;

    expect(createOmObserverWindow(branchEntries, "missing-entry")).toEqual({
      status: "rebuild",
      reason: "missing-cursor",
      branchScope: {
        leafId: "entry-2",
        entryIds: ["entry-1", "entry-2"],
        lastEntryId: "entry-2",
      },
      delta: {
        cursorId: "missing-entry",
        cursorFound: false,
        requiresRebuild: true,
        pendingEntries: [...branchEntries],
      },
      pendingEntryIds: ["entry-1", "entry-2"],
      newTurns: [],
      cursorAdvanceEntryId: null,
    });
  });

  it("returns parsed observer results from the completion helper", async () => {
    const state = createSampleState();
    const window = createReadyWindow(state);
    const expectedResult: OmObserverResult = {
      observations: [
        {
          kind: "decision",
          summary: "Observer helper emits validated JSON.",
          sourceEntryIds: ["entry-2", "entry-3"],
        },
      ],
      stableFacts: [
        {
          id: "fact-invoke",
          text: "invokeOmObserver parses valid model JSON output.",
          sourceEntryIds: ["entry-3"],
        },
      ],
      activeThreads: [
        {
          id: "thread-invoke",
          title: "Verify invokeOmObserver",
          status: "active",
          summary: "Focused invoke helper coverage.",
          sourceEntryIds: ["entry-2", "entry-3"],
        },
      ],
    };
    let capturedPrompt = "";
    let capturedSystemPrompt = "";
    let capturedOptions:
      | {
          apiKey?: string;
          headers?: Record<string, string>;
          signal?: AbortSignal;
        }
      | undefined;

    const result = await invokeOmObserver(
      {
        model: { provider: "openai", id: "gpt-5-mini" },
        modelRegistry: {
          find() {
            return undefined;
          },
          async getApiKeyAndHeaders(model) {
            expect(model).toEqual({ provider: "openai", id: "gpt-5-mini" });
            return {
              ok: true as const,
              apiKey: "observer-token",
              headers: { "x-om": "1" },
            };
          },
        },
      },
      state,
      window,
      {
        async completeFn(model, completionContext, options) {
          expect(model).toEqual({ provider: "openai", id: "gpt-5-mini" });
          expect(completionContext.messages).toHaveLength(1);
          capturedSystemPrompt = completionContext.systemPrompt ?? "";
          capturedPrompt =
            (completionContext.messages[0]?.content as { text?: string }[])[0]
              ?.text ?? "";
          capturedOptions = options;
          return createAssistantResponse(JSON.stringify(expectedResult));
        },
      }
    );

    expect(result).toEqual(expectedResult);
    expect(capturedSystemPrompt).toContain(
      "observational memory observer for pi"
    );
    expect(capturedPrompt).toContain("Please capture this observer update.");
    expect(capturedPrompt).toContain("Observer update captured.");
    expect(capturedOptions).toEqual({
      apiKey: "observer-token",
      headers: { "x-om": "1" },
      signal: undefined,
    });
  });

  it("returns an empty observer result when model auth fails", async () => {
    const state = createSampleState();
    const window = createReadyWindow(state);
    let completionCalls = 0;
    const diagnostics: OmObserverDiagnosticCode[] = [];

    const result = await invokeOmObserver(
      {
        model: { provider: "openai", id: "gpt-5-mini" },
        modelRegistry: {
          find() {
            return undefined;
          },
          async getApiKeyAndHeaders() {
            return {
              ok: false as const,
              error: "Missing auth",
            };
          },
        },
      },
      state,
      window,
      {
        onDiagnostic(diagnostic) {
          diagnostics.push(diagnostic.code);
        },
        async completeFn() {
          completionCalls += 1;
          return createAssistantResponse("{}");
        },
      }
    );

    expect(result).toEqual(createEmptyOmObserverResult());
    expect(completionCalls).toBe(0);
    expect(diagnostics).toEqual(["auth-failed"]);
  });

  it("returns an empty observer result for provider errors and preserves the error message metadata", async () => {
    const state = createSampleState();
    const window = createReadyWindow(state);
    const diagnostics: OmObserverDiagnostic[] = [];

    const result = await invokeOmObserver(
      {
        model: { provider: "openai-codex", id: "gpt-5.4" },
        modelRegistry: {
          find() {
            return undefined;
          },
          async getApiKey() {
            return "observer-token";
          },
        },
      },
      state,
      window,
      {
        onDiagnostic(diagnostic) {
          diagnostics.push(diagnostic);
        },
        async completeFn() {
          return createAssistantResponse("", {
            content: [],
            stopReason: "error",
            errorMessage: "backend rejected codex observer request",
          });
        },
      }
    );

    expect(result).toEqual(createEmptyOmObserverResult());
    expect(diagnostics).toEqual([
      {
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
      },
    ]);
  });

  it("returns an empty observer result for invalid or empty model output", async () => {
    const state = createSampleState();
    const window = createReadyWindow(state);
    const context = {
      model: { provider: "openai", id: "gpt-5-mini" },
      modelRegistry: {
        find() {
          return undefined;
        },
        async getApiKey() {
          return "observer-token";
        },
      },
    };
    const invalidDiagnostics: OmObserverDiagnostic[] = [];
    const emptyDiagnostics: OmObserverDiagnostic[] = [];

    const invalidResult = await invokeOmObserver(context, state, window, {
      onDiagnostic(diagnostic) {
        invalidDiagnostics.push(diagnostic);
      },
      async completeFn() {
        return createAssistantResponse(
          "Not JSON. I found a fact and a thread but will explain them in prose."
        );
      },
    });
    const emptyResult = await invokeOmObserver(context, state, window, {
      onDiagnostic(diagnostic) {
        emptyDiagnostics.push(diagnostic);
      },
      async completeFn() {
        return createAssistantResponse("", {
          content: [{ type: "tool-call", name: "noop" }] as any,
          stopReason: "stop",
        });
      },
    });

    expect(invalidResult).toEqual(createEmptyOmObserverResult());
    expect(emptyResult).toEqual(createEmptyOmObserverResult());
    expect(invalidDiagnostics).toEqual([
      {
        code: "invalid-output",
        meta: {
          model: "openai/gpt-5-mini",
          stopReason: "stop",
          textPreview:
            "Not JSON. I found a fact and a thread but will explain them in prose.",
          contentPartCount: 1,
          textPartCount: 1,
          textCharCount: 69,
          contentTypes: ["text"],
        },
      },
    ]);
    expect(emptyDiagnostics).toEqual([
      {
        code: "empty-output",
        meta: {
          model: "openai/gpt-5-mini",
          stopReason: "stop",
          contentPartCount: 1,
          textPartCount: 0,
          textCharCount: 0,
          contentTypes: ["tool-call"],
        },
      },
    ]);
  });

  it("reports schema error details for JSON-looking invalid observer output", async () => {
    const state = createSampleState();
    const window = createReadyWindow(state);
    const diagnostics: OmObserverDiagnostic[] = [];

    const result = await invokeOmObserver(
      {
        model: { provider: "openai", id: "gpt-5-mini" },
        modelRegistry: {
          find() {
            return undefined;
          },
          async getApiKey() {
            return "observer-token";
          },
        },
      },
      state,
      window,
      {
        onDiagnostic(diagnostic) {
          diagnostics.push(diagnostic);
        },
        async completeFn() {
          return createAssistantResponse(
            JSON.stringify({
              observations: [],
              stableFacts: [],
              activeThreads: [
                {
                  id: "thread-1",
                  title: "Finish observer diagnostics",
                  status: "in_progress",
                },
              ],
            })
          );
        },
      }
    );

    expect(result).toEqual(createEmptyOmObserverResult());
    expect(diagnostics).toEqual([
      {
        code: "invalid-output",
        meta: {
          model: "openai/gpt-5-mini",
          stopReason: "stop",
          errorMessage: undefined,
          textPreview:
            '{"observations":[],"stableFacts":[],"activeThreads":[{"id":"thread-1","title":"Finish observer diagnostics","status":"in_progress"}]}',
          contentPartCount: 1,
          textPartCount: 1,
          textCharCount: 133,
          contentTypes: ["text"],
          parsedTopLevelKeys: ["observations", "stableFacts", "activeThreads"],
          missingTopLevelKeys: [],
          validationErrorPath: "activeThreads[0].status",
          validationErrorMessage: "Expected union value",
        },
      },
    ]);
  });

  it("reports empty-result diagnostics when the model returns valid empty JSON", async () => {
    const state = createSampleState();
    const window = createReadyWindow(state);
    const diagnostics: OmObserverDiagnosticCode[] = [];

    const result = await invokeOmObserver(
      {
        model: { provider: "openai", id: "gpt-5-mini" },
        modelRegistry: {
          find() {
            return undefined;
          },
          async getApiKey() {
            return "observer-token";
          },
        },
      },
      state,
      window,
      {
        onDiagnostic(diagnostic) {
          diagnostics.push(diagnostic.code);
        },
        async completeFn() {
          return createAssistantResponse(
            JSON.stringify(createEmptyOmObserverResult())
          );
        },
      }
    );

    expect(result).toEqual(createEmptyOmObserverResult());
    expect(diagnostics).toEqual(["empty-result"]);
  });

  it("selects a fallback observer model when context.model is absent", async () => {
    const state = createSampleState();
    const window = createReadyWindow(state);
    const fallbackModel = {
      provider: "google",
      id: "gemini-2.5-flash",
      input: ["text"],
    } as const;
    const findCalls: Array<[string, string]> = [];
    let usedModel:
      | {
          provider: string;
          id: string;
        }
      | undefined;

    const result = await invokeOmObserver(
      {
        modelRegistry: {
          find(provider, modelId) {
            findCalls.push([provider, modelId]);
            return provider === fallbackModel.provider &&
              modelId === fallbackModel.id
              ? fallbackModel
              : undefined;
          },
          async getApiKey(model) {
            expect(model).toBe(fallbackModel);
            return "fallback-token";
          },
        },
      },
      state,
      window,
      {
        async completeFn(model, _completionContext, options) {
          usedModel = model;
          expect(options).toEqual({
            apiKey: "fallback-token",
            headers: undefined,
            signal: undefined,
          });
          return createAssistantResponse(
            JSON.stringify(createEmptyOmObserverResult())
          );
        },
      }
    );

    expect(result).toEqual(createEmptyOmObserverResult());
    expect(usedModel).toBe(fallbackModel);
    expect(findCalls).toEqual([
      ["anthropic", "claude-haiku-4-5"],
      ["google", "gemini-2.5-flash"],
    ]);
  });

  it("applies validated observer results into updated state and an OM envelope", () => {
    const updatedAt = "2026-04-04T01:23:45.000Z";
    const state = createSampleState({
      activeThreads: [
        {
          id: "thread-existing",
          title: "Scaffold OM",
          status: "waiting",
          sourceEntryIds: ["entry-1"],
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ],
    });
    const window = createOmObserverWindow(
      [
        {
          id: "entry-1",
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Existing." }],
          },
        },
        {
          id: "entry-2",
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "Please finish OM observer helpers." },
            ],
          },
        },
        {
          id: "entry-3",
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Implementing the pure helper now." },
            ],
          },
        },
      ],
      state.lastProcessedEntryId,
      {
        observationMessageTokens: estimateTurnBudget([
          {
            id: "entry-2",
            role: "user",
            text: "Please finish OM observer helpers.",
          },
          {
            id: "entry-3",
            role: "assistant",
            text: "Implementing the pure helper now.",
          },
        ]),
      }
    );
    const observerResult: OmObserverResult = {
      observations: [
        {
          kind: "decision",
          summary: "Keep OM observer work pure until turn_end wiring lands.",
          sourceEntryIds: ["entry-3", "ignored-entry"],
        },
      ],
      stableFacts: [
        {
          id: "fact-existing",
          text: "OM observer helpers stay pure for now.",
        },
      ],
      activeThreads: [
        {
          id: "thread-existing",
          title: "Finish OM observer helpers",
          status: "active",
          summary: "Pure helpers and focused tests.",
        },
      ],
    };

    expect(isOmObserverResult(observerResult)).toBe(true);

    const applied = applyOmObserverResult(
      state,
      window,
      observerResult,
      updatedAt
    );

    expect(applied.status).toBe("applied");
    expect(applied.reason).toBe("updated-state");
    expect(applied.shouldPersist).toBe(true);
    expect(applied.state.lastProcessedEntryId).toBe("entry-3");
    expect(applied.state.updatedAt).toBe(updatedAt);
    expect(applied.state.observations).toEqual([
      {
        id: "obs-entry-3-2026-04-04T01:23:45.000Z-1",
        kind: "decision",
        summary: "Keep OM observer work pure until turn_end wiring lands.",
        sourceEntryIds: ["entry-3"],
        createdAt: updatedAt,
      },
    ]);
    expect(applied.state.stableFacts).toEqual([
      {
        id: "fact-existing",
        text: "OM observer helpers stay pure for now.",
        sourceEntryIds: ["entry-2", "entry-3"],
        updatedAt,
      },
    ]);
    expect(applied.state.activeThreads).toEqual([
      {
        id: "thread-existing",
        title: "Finish OM observer helpers",
        status: "active",
        summary: "Pure helpers and focused tests.",
        sourceEntryIds: ["entry-2", "entry-3"],
        updatedAt,
      },
    ]);
    expect(applied.envelope.branchScope).toEqual(window.branchScope);
    expect(applied.envelope.state).toEqual(applied.state);
  });

  it("overwrites provided continuation hints and retains omitted ones", () => {
    const state = createSampleState({
      currentTask: "Keep the old task until the observer updates it.",
      suggestedNextResponse: "Return the current validation summary.",
    });
    const window = createReadyWindow(state);

    const applied = applyOmObserverResult(
      state,
      window,
      {
        observations: [],
        stableFacts: [],
        activeThreads: [],
        currentTask: "Finish OM continuation hints and tests.",
      },
      "2026-04-04T02:00:00.000Z"
    );

    expect(applied).toMatchObject({
      status: "applied",
      reason: "updated-state",
      shouldPersist: true,
    });
    expect(applied.state.currentTask).toBe(
      "Finish OM continuation hints and tests."
    );
    expect(applied.state.suggestedNextResponse).toBe(
      "Return the current validation summary."
    );
  });

  it("retains continuation hints when the observer omits them", () => {
    const state = createSampleState({
      currentTask: "Keep tracking OM continuation coverage.",
      suggestedNextResponse: "Summarize the remaining validation work.",
    });
    const window = createReadyWindow(state);

    const applied = applyOmObserverResult(
      state,
      window,
      { observations: [], stableFacts: [], activeThreads: [] },
      "2026-04-04T02:00:00.000Z"
    );

    expect(applied).toMatchObject({
      status: "noop",
      reason: "cursor-advanced",
      shouldPersist: true,
    });
    expect(applied.state.currentTask).toBe(
      "Keep tracking OM continuation coverage."
    );
    expect(applied.state.suggestedNextResponse).toBe(
      "Summarize the remaining validation work."
    );
  });

  it("does not auto-clear continuation hints from blank observer strings", () => {
    const state = createSampleState({
      currentTask: "Keep the current task visible.",
      suggestedNextResponse: "Keep the suggested next response visible.",
    });
    const window = createReadyWindow(state);

    const applied = applyOmObserverResult(
      state,
      window,
      {
        observations: [],
        stableFacts: [],
        activeThreads: [],
        currentTask: "   ",
        suggestedNextResponse: "\n\t",
      },
      "2026-04-04T02:00:00.000Z"
    );

    expect(applied).toMatchObject({
      status: "noop",
      reason: "cursor-advanced",
      shouldPersist: true,
    });
    expect(applied.state.currentTask).toBe("Keep the current task visible.");
    expect(applied.state.suggestedNextResponse).toBe(
      "Keep the suggested next response visible."
    );
  });

  it("does not advance the cursor when the observer threshold is not met", () => {
    const state = createSampleState();
    const thresholdWindow = createOmObserverWindow(
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
            role: "assistant",
            content: [{ type: "text", text: "Short pending update." }],
          },
        },
      ],
      state.lastProcessedEntryId,
      {
        observationMessageTokens:
          estimateTurnBudget([
            {
              id: "entry-2",
              role: "assistant",
              text: "Short pending update.",
            },
          ]) + 1,
      }
    );

    const noopResult = applyOmObserverResult(
      state,
      thresholdWindow,
      { observations: [], stableFacts: [], activeThreads: [] },
      "2026-04-04T02:00:00.000Z"
    );

    expect(noopResult).toMatchObject({
      status: "noop",
      reason: "threshold-not-met",
      shouldPersist: false,
    });
    expect(noopResult.state.lastProcessedEntryId).toBe(
      state.lastProcessedEntryId
    );
    expect(noopResult.state.updatedAt).toBe(state.updatedAt);
  });

  it("advances the cursor without persisting duplicate or rebuild windows", () => {
    const state = createSampleState();
    const noopWindow = createOmObserverWindow(
      [
        {
          id: "entry-1",
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Already processed." }],
          },
        },
        { id: "custom-state", type: "custom", customType: "other-custom" },
      ],
      state.lastProcessedEntryId
    );
    const duplicateWindow = createOmObserverWindow(
      [
        {
          id: "entry-1",
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Already processed." }],
          },
        },
      ],
      state.lastProcessedEntryId
    );
    const rebuildWindow = createOmObserverWindow(
      [
        {
          id: "entry-2",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Need a rebuild." }],
          },
        },
      ],
      "missing-entry"
    );

    const noopResult = applyOmObserverResult(
      state,
      noopWindow,
      { observations: [], stableFacts: [], activeThreads: [] },
      "2026-04-04T02:00:00.000Z"
    );
    expect(noopResult).toMatchObject({
      status: "noop",
      reason: "cursor-advanced",
      shouldPersist: true,
    });
    expect(noopResult.state.lastProcessedEntryId).toBe("custom-state");
    expect(noopResult.state.observations).toEqual(state.observations);

    const duplicateResult = applyOmObserverResult(
      state,
      duplicateWindow,
      { observations: [], stableFacts: [], activeThreads: [] },
      "2026-04-04T02:00:00.000Z"
    );
    expect(duplicateResult).toMatchObject({
      status: "duplicate",
      reason: "no-new-entries",
      shouldPersist: false,
      state,
    });

    const rebuildResult = applyOmObserverResult(
      state,
      rebuildWindow,
      { observations: [], stableFacts: [], activeThreads: [] },
      "2026-04-04T02:00:00.000Z"
    );
    expect(rebuildResult).toMatchObject({
      status: "noop",
      reason: "requires-rebuild",
      shouldPersist: false,
      state,
    });
  });
});
