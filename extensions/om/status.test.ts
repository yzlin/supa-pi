import { describe, expect, it } from "bun:test";

import { type OmStatusSnapshot, showOmStatusView } from "./status";

describe("om status view", () => {
  it("renders the interactive overlay without throwing", async () => {
    const snapshot: OmStatusSnapshot = {
      counts: {
        stableFacts: 1,
        activeThreads: 1,
        observations: 2,
        reflections: 1,
      },
      recentEvents: [
        {
          createdAt: "2026-04-05T00:00:01.000Z",
          level: "success",
          message: "OM observer applied: +1 observation, +1 fact.",
        },
        {
          createdAt: "2026-04-05T00:00:02.000Z",
          level: "info",
          message: "OM reflected 2 observations into 1 reflection.",
        },
      ],
      lastProcessedEntryId: "entry-2",
      restore: "incremental/cursor-found",
      updatedAt: "2026-04-05T00:00:00.000Z",
      observer: {
        status: "ready",
        reason: "new-turns",
        pendingEntryCount: 2,
        pendingTurnCount: 2,
        pendingTokens: 120,
        thresholdTokens: 100,
        blockAfterTokens: 120,
        bufferTokens: 60,
        bufferThresholdTokens: 80,
        bufferStatus: "pending",
        bufferSourceCount: 1,
      },
      reflector: {
        status: "noop",
        reason: "threshold-not-met",
        retainedObservationCount: 2,
        retainedObservationTokens: 40,
        thresholdTokens: 100,
        blockAfterTokens: 120,
        observationsToReflectCount: 0,
        bufferTokens: 20,
        bufferThresholdTokens: 50,
        bufferStatus: "pending",
        bufferSourceCount: 1,
      },
    };

    const renders: string[][] = [];

    await showOmStatusView(
      {
        hasUI: true,
        ui: {
          notify() {},
          async custom(factory: any) {
            const component = factory(
              {},
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              {},
              () => {}
            );

            renders.push(component.render(80));
          },
        },
      } as any,
      snapshot
    );

    expect(renders).toHaveLength(1);
    expect(renders[0]?.join("\n")).toContain("Observational Memory Status");
    expect(renders[0]?.join("\n")).toContain("Buffered observation");
    expect(renders[0]?.join("\n")).toContain("Buffered reflection");
    expect(renders[0]?.join("\n")).toContain("Recent activity");
    expect(renders[0]?.join("\n")).toContain(
      "OM observer applied: +1 observation, +1 fact."
    );
  });
});
