import { describe, expect, it } from "bun:test";

import { DEFAULT_OM_CONFIG_SNAPSHOT } from "./config";
import {
  createOmHeaderContextMessage,
  injectOmHeaderMessage,
  mergeOmCompactionSummary,
  OM_HEADER_CUSTOM_TYPE,
  shouldInjectOmHeader,
} from "./prompt-integration";
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
        summary: "Recent note.",
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
      {
        id: "fact-2",
        text: "OM stays branch-local.",
        sourceEntryIds: ["entry-2"],
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
    ],
    activeThreads: [
      {
        id: "thread-1",
        title: "Finish OM extension",
        status: "active",
        summary: "Header and compaction next.",
        sourceEntryIds: ["entry-3"],
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
      {
        id: "thread-2",
        title: "Keep this hidden",
        status: "waiting",
        sourceEntryIds: ["entry-4"],
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
    ],
    configSnapshot: {
      ...DEFAULT_OM_CONFIG_SNAPSHOT,
      headerMaxFacts: 1,
      headerMaxThreads: 1,
    },
    updatedAt: "2026-04-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("om prompt integration helpers", () => {
  it("builds a bounded hidden OM header message", () => {
    const message = createOmHeaderContextMessage(createSampleState());

    expect(message).toMatchObject({
      role: "custom",
      customType: OM_HEADER_CUSTOM_TYPE,
      display: false,
    });
    expect(message?.content).toContain("[Observational Memory]");
    expect(message?.content).toContain("User prefers minimal diffs.");
    expect(message?.content).toContain("Finish OM extension");
    expect(message?.content).not.toContain("OM stays branch-local.");
    expect(message?.content).not.toContain("Keep this hidden");
  });

  it("skips header injection when the same OM header is already present", () => {
    const state = createSampleState();
    const headerMessage = createOmHeaderContextMessage(state)!;
    const messages = [
      headerMessage,
      { role: "user", content: "Continue." },
    ] as const;

    expect(shouldInjectOmHeader(messages, headerMessage.content)).toBe(false);
    expect(injectOmHeaderMessage(messages, state)).toEqual([...messages]);
  });

  it("injects the OM header once and keeps prompt bloat bounded", () => {
    const state = createSampleState();
    const injected = injectOmHeaderMessage(
      [{ role: "user", content: "Continue." }],
      state
    );

    expect(injected[0]).toMatchObject({
      role: "custom",
      customType: OM_HEADER_CUSTOM_TYPE,
      display: false,
    });
    expect(
      String((injected[0] as { content: string }).content).split("\n").length
    ).toBeLessThanOrEqual(6);
  });

  it("merges OM payload into a prior summary and replaces earlier OM sections stably", () => {
    const state = createSampleState();
    const merged = mergeOmCompactionSummary(
      "## Goal\nShip OM.\n\n## Progress\nObserver done.",
      state
    );

    expect(merged).toContain("## Goal");
    expect(merged).toContain("## Progress");
    expect(merged).toContain("## Observational Memory");
    expect(merged).toContain("### Stable Facts");

    const mergedAgain = mergeOmCompactionSummary(merged, state);
    expect(mergedAgain?.match(/## Observational Memory/g)?.length).toBe(1);
  });

  it("noops before first compaction when there is no prior summary", () => {
    expect(mergeOmCompactionSummary("", createSampleState())).toBeNull();
    expect(mergeOmCompactionSummary(undefined, createSampleState())).toBeNull();
  });
});
