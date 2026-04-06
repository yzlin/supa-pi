import { describe, expect, it } from "bun:test";

import { type AssistantMessage } from "@mariozechner/pi-ai";

import { DEFAULT_OM_CONFIG_SNAPSHOT, mergeOmConfigSnapshot } from "./config";
import {
  applyOmReflectorResult,
  buildOmReflectorPromptForWindow,
  createEmptyOmReflectorResult,
  createOmReflectorPromptInput,
  createOmReflectorWindow,
  invokeOmReflector,
  parseOmReflectorResultText,
} from "./reflector";
import { isOmReflectorResult } from "./schema";
import { estimateOmObservationTokens } from "./tokens";
import type { OmReflectorResult, OmStateV1 } from "./types";
import { OM_STATE_VERSION } from "./version";

function createSampleState(overrides: Partial<OmStateV1> = {}): OmStateV1 {
  const { configSnapshot: configOverrides, ...stateOverrides } = overrides;

  return {
    version: OM_STATE_VERSION,
    lastProcessedEntryId: "entry-4",
    observations: [
      {
        id: "obs-1",
        kind: "fact",
        summary: "User wants OM to stay branch-local.",
        sourceEntryIds: ["entry-1"],
        createdAt: "2026-04-04T00:00:00.000Z",
      },
      {
        id: "obs-2",
        kind: "decision",
        summary: "Build the reflector after the observer pipeline.",
        sourceEntryIds: ["entry-2"],
        createdAt: "2026-04-04T00:01:00.000Z",
      },
      {
        id: "obs-3",
        kind: "thread",
        summary: "Prompt integration is still pending.",
        sourceEntryIds: ["entry-3"],
        createdAt: "2026-04-04T00:02:00.000Z",
      },
      {
        id: "obs-4",
        kind: "risk",
        summary: "Over-reflection can hide recent detail.",
        sourceEntryIds: ["entry-4"],
        createdAt: "2026-04-04T00:03:00.000Z",
      },
    ],
    reflections: [
      {
        id: "refl-existing",
        summary: "Prefer repo-native extensions over scripts.",
        sourceObservationIds: ["obs-0"],
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    stableFacts: [],
    activeThreads: [],
    configSnapshot: mergeOmConfigSnapshot(DEFAULT_OM_CONFIG_SNAPSHOT, {
      reflectionMinObservationCount: 3,
      reflectionObservationTokens: 1,
      ...configOverrides,
    }),
    updatedAt: "2026-04-04T00:04:00.000Z",
    ...stateOverrides,
  };
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

describe("om reflector helpers", () => {
  it("parses valid reflector result JSON", () => {
    const reflectorResultText = JSON.stringify({
      reflections: [
        {
          summary: "Compress older OM observations into a durable summary.",
          sourceObservationIds: ["obs-1"],
        },
      ],
    });

    const parsedResult = parseOmReflectorResultText(reflectorResultText);

    expect(parsedResult).toEqual({
      reflections: [
        {
          summary: "Compress older OM observations into a durable summary.",
          sourceObservationIds: ["obs-1"],
        },
      ],
    });
    expect(isOmReflectorResult(parsedResult)).toBe(true);
  });

  it("falls back to an empty reflector result for invalid or empty output", () => {
    expect(parseOmReflectorResultText("{not json}")).toEqual(
      createEmptyOmReflectorResult()
    );
    expect(parseOmReflectorResultText("   \n\t  ")).toEqual(
      createEmptyOmReflectorResult()
    );
    expect(parseOmReflectorResultText(null)).toEqual(
      createEmptyOmReflectorResult()
    );
  });

  it("parses fenced JSON reflector output", () => {
    const parsedResult = parseOmReflectorResultText(`Reflect older items.

\`\`\`json
{
  "reflections": [
    {
      "summary": "Fenced JSON is accepted.",
      "sourceObservationIds": ["obs-2"]
    }
  ]
}
\`\`\`
`);

    expect(parsedResult).toEqual({
      reflections: [
        {
          summary: "Fenced JSON is accepted.",
          sourceObservationIds: ["obs-2"],
        },
      ],
    });
    expect(isOmReflectorResult(parsedResult)).toBe(true);
  });

  it("returns noop until the reflection token threshold is reached", () => {
    const state = createSampleState({
      configSnapshot: {
        ...createSampleState().configSnapshot,
        reflectionObservationTokens:
          createSampleState().observations.reduce(
            (totalTokens, observation) =>
              totalTokens + estimateOmObservationTokens(observation),
            0
          ) + 1,
      },
    });

    expect(createOmReflectorWindow(state)).toEqual({
      status: "noop",
      reason: "threshold-not-met",
      observationsToReflect: [],
      retainedObservations: state.observations,
    });
  });

  it("uses the observation token threshold as the primary reflection gate", () => {
    const state = createSampleState({
      observations: createSampleState().observations.slice(0, 2),
      configSnapshot: {
        ...createSampleState().configSnapshot,
        reflection: {
          ...createSampleState().configSnapshot.reflection,
          observationTokens:
            estimateOmObservationTokens(createSampleState().observations[1]) +
            1,
          blockAfter: 100,
        },
        reflectionObservationTokens:
          estimateOmObservationTokens(createSampleState().observations[1]) + 1,
        reflectionMinObservationCount: 99,
      },
    });

    expect(createOmReflectorWindow(state)).toMatchObject({
      status: "ready",
      reason: "ready",
      observationsToReflect: [state.observations[0]],
      retainedObservations: [state.observations[1]],
    });
  });

  it("marks reflector windows as block-after once observation load exceeds the safety ratio", () => {
    const state = createSampleState({
      configSnapshot: {
        ...createSampleState().configSnapshot,
        reflection: {
          ...createSampleState().configSnapshot.reflection,
          observationTokens:
            createSampleState().observations.reduce(
              (totalTokens, observation) =>
                totalTokens + estimateOmObservationTokens(observation),
              0
            ) - 1,
          blockAfter: 1,
        },
        reflectionObservationTokens:
          createSampleState().observations.reduce(
            (totalTokens, observation) =>
              totalTokens + estimateOmObservationTokens(observation),
            0
          ) - 1,
      },
    });

    expect(createOmReflectorWindow(state)).toMatchObject({
      status: "ready",
      reason: "block-after",
    });
  });

  it("preserves recency by retaining the newest observations under token pressure", () => {
    const sampleState = createSampleState();
    const retainedObservationTokens =
      estimateOmObservationTokens(sampleState.observations[2]) +
      estimateOmObservationTokens(sampleState.observations[3]) +
      1;
    const state = createSampleState({
      configSnapshot: {
        ...sampleState.configSnapshot,
        reflection: {
          ...sampleState.configSnapshot.reflection,
          observationTokens: retainedObservationTokens,
          blockAfter: 100,
        },
        reflectionObservationTokens: retainedObservationTokens,
      },
    });
    const window = createOmReflectorWindow(state);

    expect(window).toMatchObject({
      status: "ready",
      reason: "ready",
      observationsToReflect: [state.observations[0], state.observations[1]],
      retainedObservations: [state.observations[2], state.observations[3]],
    });

    const promptInput = createOmReflectorPromptInput(state, window);
    expect(promptInput).toEqual({
      observations: window.observationsToReflect,
      reflections: state.reflections,
      stableFacts: state.stableFacts,
      activeThreads: state.activeThreads,
      configSnapshot: state.configSnapshot,
    });

    const prompt = buildOmReflectorPromptForWindow(state, window);
    expect(prompt).toContain(
      "You are the observational memory reflector for pi."
    );
    expect(prompt).toContain("reflectionMinObservationCount: 3");
    expect(prompt).toContain(
      "[obs-1] (fact) User wants OM to stay branch-local."
    );
    expect(prompt).toContain(
      "[refl-existing] Prefer repo-native extensions over scripts."
    );
  });

  it("retains the newest observation even when it alone exceeds the token threshold", () => {
    const state = createSampleState({
      observations: [
        {
          id: "obs-1",
          kind: "fact",
          summary: "Short observation.",
          sourceEntryIds: ["entry-1"],
          createdAt: "2026-04-04T00:00:00.000Z",
        },
        {
          id: "obs-2",
          kind: "decision",
          summary: "Another short observation.",
          sourceEntryIds: ["entry-2"],
          createdAt: "2026-04-04T00:01:00.000Z",
        },
        {
          id: "obs-3",
          kind: "risk",
          summary:
            "This newest observation is intentionally large enough to exceed the retained token threshold by itself.",
          sourceEntryIds: ["entry-3"],
          createdAt: "2026-04-04T00:02:00.000Z",
        },
      ],
      configSnapshot: {
        ...createSampleState().configSnapshot,
        reflection: {
          ...createSampleState().configSnapshot.reflection,
          observationTokens: 5,
          blockAfter: 100,
        },
        reflectionMinObservationCount: 3,
        reflectionObservationTokens: 5,
      },
    });

    expect(createOmReflectorWindow(state)).toMatchObject({
      status: "ready",
      reason: "ready",
      observationsToReflect: [state.observations[0], state.observations[1]],
      retainedObservations: [state.observations[2]],
    });
  });

  it("applies new reflections and drops only the reflected observations", () => {
    const updatedAt = "2026-04-04T01:00:00.000Z";
    const state = createSampleState();
    const window = createOmReflectorWindow(state);
    const reflectorResult = {
      reflections: [
        {
          summary:
            "OM should compress older observations while keeping recent ones live.",
          sourceObservationIds: ["obs-1"],
        },
      ],
    };

    expect(isOmReflectorResult(reflectorResult)).toBe(true);

    const applied = applyOmReflectorResult(
      state,
      window,
      reflectorResult,
      updatedAt
    );

    expect(applied).toMatchObject({
      status: "applied",
      reason: "reflected",
      shouldPersist: true,
    });
    expect(applied.state.observations).toEqual(window.retainedObservations);
    expect(applied.state.reflections).toEqual([
      ...state.reflections,
      {
        id: "refl-2026-04-04T01:00:00.000Z-1",
        summary:
          "OM should compress older observations while keeping recent ones live.",
        sourceObservationIds: ["obs-1"],
        createdAt: updatedAt,
      },
    ]);
  });

  it("returns parsed reflector results from the completion helper", async () => {
    const state = createSampleState();
    const window = createOmReflectorWindow(state);
    const completeCalls: Array<{
      model: { id: string; provider: string };
      systemPrompt?: string;
      prompt: string;
      apiKey?: string;
      headers?: Record<string, string>;
    }> = [];

    const result = await invokeOmReflector(
      {
        model: {
          id: "test-model",
          provider: "openai",
        },
        modelRegistry: {
          find() {
            return undefined;
          },
          async getApiKeyAndHeaders() {
            return { ok: true as const, apiKey: "key", headers: { a: "b" } };
          },
        },
      },
      state,
      window,
      {
        completeFn: async (model, context, options) => {
          completeCalls.push({
            model,
            systemPrompt: context.systemPrompt,
            prompt:
              context.messages[0]?.content[0]?.type === "text"
                ? context.messages[0].content[0].text
                : "",
            apiKey: options?.apiKey,
            headers: options?.headers,
          });

          return createAssistantResponse(
            JSON.stringify({
              reflections: [
                {
                  summary: "Compress older observations.",
                  sourceObservationIds: ["obs-1"],
                },
              ],
            } satisfies OmReflectorResult)
          );
        },
      }
    );

    expect(result).toEqual({
      reflections: [
        {
          summary: "Compress older observations.",
          sourceObservationIds: ["obs-1"],
        },
      ],
    });
    expect(completeCalls[0]?.systemPrompt).toContain(
      "observational memory reflector for pi"
    );
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0]).toMatchObject({
      model: { id: "test-model", provider: "openai" },
      apiKey: "key",
      headers: { a: "b" },
    });
    expect(completeCalls[0]?.prompt).toContain(
      "You are the observational memory reflector for pi."
    );
  });

  it("returns an empty reflector result when model auth fails", async () => {
    const state = createSampleState();
    const window = createOmReflectorWindow(state);

    const result = await invokeOmReflector(
      {
        model: {
          id: "test-model",
          provider: "openai",
        },
        modelRegistry: {
          find() {
            return undefined;
          },
          async getApiKeyAndHeaders() {
            return { ok: false as const, error: "missing key" };
          },
        },
      },
      state,
      window
    );

    expect(result).toEqual(createEmptyOmReflectorResult());
  });

  it("returns an empty reflector result for invalid or empty model output", async () => {
    const state = createSampleState();
    const window = createOmReflectorWindow(state);
    const context = {
      model: {
        id: "test-model",
        provider: "openai",
      },
      modelRegistry: {
        find() {
          return undefined;
        },
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "key" };
        },
      },
    };

    await expect(
      invokeOmReflector(context, state, window, {
        completeFn: async () => createAssistantResponse("{not json}"),
      })
    ).resolves.toEqual(createEmptyOmReflectorResult());

    await expect(
      invokeOmReflector(context, state, window, {
        completeFn: async () => createAssistantResponse("   \n\t  "),
      })
    ).resolves.toEqual(createEmptyOmReflectorResult());
  });

  it("returns a shared empty reflector result and noops when there is nothing to apply", () => {
    const state = createSampleState();
    const window = createOmReflectorWindow(state);

    expect(createEmptyOmReflectorResult()).toEqual({ reflections: [] });
    expect(isOmReflectorResult(createEmptyOmReflectorResult())).toBe(true);

    const applied = applyOmReflectorResult(
      state,
      window,
      createEmptyOmReflectorResult(),
      "2026-04-04T01:00:00.000Z"
    );

    expect(applied).toMatchObject({
      status: "noop",
      reason: "no-observations-to-reflect",
      shouldPersist: false,
      state,
    });
  });
});
