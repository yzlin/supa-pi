import { describe, expect, it } from "bun:test";

import { type AssistantMessage } from "@mariozechner/pi-ai";

import {
  buildOmCompactionPrompt,
  generateOmCompactionSummary,
} from "./compaction";
import { DEFAULT_OM_CONFIG_SNAPSHOT } from "./config";
import type { OmStateV1 } from "./types";
import { OM_STATE_VERSION } from "./version";

function createSampleState(overrides: Partial<OmStateV1> = {}): OmStateV1 {
  return {
    version: OM_STATE_VERSION,
    lastProcessedEntryId: "entry-3",
    observations: [
      {
        id: "obs-1",
        kind: "fact",
        summary: "Recent observation.",
        sourceEntryIds: ["entry-3"],
        createdAt: "2026-04-04T00:00:00.000Z",
      },
    ],
    reflections: [
      {
        id: "refl-1",
        summary: "Long-running summary.",
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
        title: "Finish OM extension",
        status: "active",
        sourceEntryIds: ["entry-2"],
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
    ],
    configSnapshot: DEFAULT_OM_CONFIG_SNAPSHOT,
    updatedAt: "2026-04-04T00:00:00.000Z",
    ...overrides,
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

describe("om compaction helper", () => {
  it("builds a native-style compaction prompt without embedding OM sections directly", () => {
    const prompt = buildOmCompactionPrompt(
      {
        conversationText: "User: continue\nAssistant: working on it",
        previousSummary: "## Goal\nShip OM",
        firstKeptEntryId: "entry-3",
        tokensBefore: 42,
      },
      createSampleState()
    );

    expect(prompt).toContain("## Goal");
    expect(prompt).toContain("## Constraints & Preferences");
    expect(prompt).toContain("## Critical Context");
    expect(prompt).toContain("Do not emit an Observational Memory section");
    expect(prompt).not.toContain("### Stable Facts");
  });

  it("noops before first compaction when there is no previous summary", async () => {
    const result = await generateOmCompactionSummary(
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
            return { ok: true as const, apiKey: "key" };
          },
        },
      },
      createSampleState(),
      {
        conversationText: "User: continue",
        previousSummary: "",
        firstKeptEntryId: "entry-3",
        tokensBefore: 42,
      }
    );

    expect(result).toBeNull();
  });

  it("merges OM state into the generated summary and keeps repeated augmentation stable", async () => {
    const state = createSampleState();
    const capturedSystemPrompts: string[] = [];
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

    const result = await generateOmCompactionSummary(
      context,
      state,
      {
        conversationText: "User: continue",
        previousSummary: "## Goal\nShip OM",
        firstKeptEntryId: "entry-3",
        tokensBefore: 42,
      },
      {
        completeFn: async (_model, completionContext) => {
          capturedSystemPrompts.push(completionContext.systemPrompt ?? "");
          return createAssistantResponse(
            "## Goal\nShip OM\n\n## Progress\nObserver and reflector helpers landed."
          );
        },
      }
    );

    expect(result).toMatchObject({
      firstKeptEntryId: "entry-3",
      tokensBefore: 42,
    });
    expect(result?.summary).toContain("## Goal");
    expect(result?.summary).toContain("## Observational Memory");
    expect(capturedSystemPrompts[0]).toContain(
      "updating a running pi compaction summary"
    );
    expect(result?.summary?.match(/## Observational Memory/g)?.length).toBe(1);

    const stableRepeat = await generateOmCompactionSummary(
      context,
      state,
      {
        conversationText: "User: continue",
        previousSummary: result?.summary,
        firstKeptEntryId: "entry-3",
        tokensBefore: 42,
      },
      {
        completeFn: async () => createAssistantResponse(result?.summary ?? ""),
      }
    );

    expect(
      stableRepeat?.summary?.match(/## Observational Memory/g)?.length
    ).toBe(1);
  });
});
