import { describe, expect, it } from "bun:test";

import { DEFAULT_OM_CONFIG_SNAPSHOT } from "./config";
import {
  estimateOmCompactionPayloadTokens,
  estimateOmHeaderTokens,
  estimateOmObservationTokens,
  estimateOmReflectionTokens,
  estimateOmTextTokens,
  estimateOmTurnTokens,
  selectObservationsWithinTokenBudget,
  selectReflectionsWithinTokenBudget,
  selectTurnsWithinTokenBudget,
} from "./tokens";
import type { OmObservation, OmPromptTurn, OmReflection } from "./types";

describe("om token helpers", () => {
  it("estimates text tokens deterministically", () => {
    expect(estimateOmTextTokens("")).toBe(0);
    expect(estimateOmTextTokens("1234")).toBe(1);
    expect(estimateOmTextTokens("12345")).toBe(2);
  });

  it("estimates turns, observations, reflections, headers, and compaction payloads", () => {
    const turn: OmPromptTurn = {
      id: "turn-1",
      role: "user",
      text: "Need a deterministic approximation.",
    };
    const observation: OmObservation = {
      id: "obs-1",
      kind: "fact",
      summary: "User asked for token-aware OM helpers.",
      sourceEntryIds: ["entry-1"],
      createdAt: "2026-04-04T00:00:00.000Z",
    };
    const reflection: OmReflection = {
      id: "refl-1",
      summary: "OM should stay deterministic during rollout.",
      sourceObservationIds: ["obs-1"],
      createdAt: "2026-04-04T00:00:00.000Z",
    };

    expect(estimateOmTurnTokens(turn)).toBe(
      estimateOmTextTokens("[turn-1] user: Need a deterministic approximation.")
    );
    expect(estimateOmObservationTokens(observation)).toBe(
      estimateOmTextTokens(
        "[obs-1] (fact) User asked for token-aware OM helpers."
      )
    );
    expect(estimateOmReflectionTokens(reflection)).toBe(
      estimateOmTextTokens(
        "[refl-1] OM should stay deterministic during rollout."
      )
    );
    expect(
      estimateOmHeaderTokens({
        stableFacts: [
          {
            id: "fact-1",
            text: "OM is branch-local.",
            sourceEntryIds: ["entry-1"],
            updatedAt: "2026-04-04T00:00:00.000Z",
          },
        ],
        activeThreads: [
          {
            id: "thread-1",
            title: "Add token helpers",
            status: "active",
            summary: "Keep rollout safe.",
            sourceEntryIds: ["entry-1"],
            updatedAt: "2026-04-04T00:00:00.000Z",
          },
        ],
        configSnapshot: DEFAULT_OM_CONFIG_SNAPSHOT,
      })
    ).toBeGreaterThan(0);
    expect(
      estimateOmCompactionPayloadTokens({
        stableFacts: [],
        activeThreads: [],
        observations: [observation],
        reflections: [reflection],
        configSnapshot: DEFAULT_OM_CONFIG_SNAPSHOT,
      })
    ).toBeGreaterThan(estimateOmObservationTokens(observation));
  });

  it("selects newest items within a token budget and handles falsey edge cases", () => {
    const turns: OmPromptTurn[] = [
      { id: "turn-1", role: "user", text: "1234" },
      { id: "turn-2", role: "assistant", text: "12345678" },
      { id: "turn-3", role: "user", text: "123456789012" },
    ];
    const observations: OmObservation[] = turns.map((turn, index) => ({
      id: `obs-${index + 1}`,
      kind: "fact",
      summary: turn.text,
      sourceEntryIds: [turn.id],
      createdAt: "2026-04-04T00:00:00.000Z",
    }));
    const reflections: OmReflection[] = observations.map(
      (observation, index) => ({
        id: `refl-${index + 1}`,
        summary: observation.summary,
        sourceObservationIds: [observation.id],
        createdAt: "2026-04-04T00:00:00.000Z",
      })
    );

    expect(selectTurnsWithinTokenBudget(turns, false)).toEqual(turns);
    expect(selectTurnsWithinTokenBudget(turns, 0)).toEqual([]);
    expect(
      selectTurnsWithinTokenBudget(turns, estimateOmTurnTokens(turns[2]))
    ).toEqual([turns[2]]);
    expect(
      selectObservationsWithinTokenBudget(
        observations,
        estimateOmObservationTokens(observations[1]) +
          estimateOmObservationTokens(observations[2])
      )
    ).toEqual([observations[1], observations[2]]);
    expect(selectReflectionsWithinTokenBudget(reflections, 1)).toEqual([]);
  });

  it("retains the full newest window once the threshold decision has already been made elsewhere", () => {
    const turns: OmPromptTurn[] = [
      { id: "turn-1", role: "user", text: "older" },
      { id: "turn-2", role: "assistant", text: "newer" },
    ];

    expect(selectTurnsWithinTokenBudget(turns, false)).toEqual(turns);
  });
});
