import { describe, expect, it } from "bun:test";

import {
  formatOmStatusSummary,
  type OmStatusSnapshot,
  showOmStatusView,
} from "./status";

describe("om status view", () => {
  it("summarizes repeated recent failure reasons compactly", () => {
    const snapshot: OmStatusSnapshot = {
      counts: {
        stableFacts: 0,
        activeThreads: 0,
        observations: 0,
        reflections: 0,
      },
      recentEvents: [
        {
          createdAt: "2026-04-05T00:00:01.000Z",
          level: "warning",
          message:
            "OM observer skipped 1 pending entry: no observer model available.",
        },
        {
          createdAt: "2026-04-05T00:00:02.000Z",
          level: "warning",
          message: "OM observer returned invalid JSON for 1 pending entry.",
        },
        {
          createdAt: "2026-04-05T00:00:03.000Z",
          level: "warning",
          message: "OM observation buffer returned invalid JSON for 1 entry.",
        },
      ],
      lastProcessedEntryId: null,
      restore: "none",
      updatedAt: "2026-04-05T00:00:00.000Z",
      observer: {
        status: "noop",
        reason: "threshold-not-met",
        pendingEntryCount: 0,
        pendingTurnCount: 0,
        pendingTokens: 0,
        thresholdTokens: 100,
        blockAfterTokens: 120,
        bufferTokens: 0,
        bufferThresholdTokens: 80,
        bufferStatus: "none",
        bufferSourceCount: 0,
      },
      reflector: {
        status: "noop",
        reason: "threshold-not-met",
        retainedObservationCount: 0,
        retainedObservationTokens: 0,
        thresholdTokens: 100,
        blockAfterTokens: 120,
        observationsToReflectCount: 0,
        bufferTokens: 0,
        bufferThresholdTokens: 50,
        bufferStatus: "none",
        bufferSourceCount: 0,
      },
    };

    expect(formatOmStatusSummary(snapshot)).toContain(
      "failures=invalid-json×2, missing-model×1"
    );
  });

  it("renders the interactive overlay without throwing", async () => {
    const snapshot: OmStatusSnapshot = {
      counts: {
        stableFacts: 1,
        activeThreads: 1,
        observations: 2,
        reflections: 1,
      },
      continuation: {
        currentTask: "Finish OM continuation coverage.",
        suggestedNextResponse: "Return the targeted OM validation summary.",
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
    expect(renders[0]?.join("\n")).toContain("Continuation");
    expect(renders[0]?.join("\n")).toContain(
      "Finish OM continuation coverage."
    );
    expect(renders[0]?.join("\n")).toContain("Recent activity");
    expect(renders[0]?.join("\n")).toContain(
      "OM observer applied: +1 observation, +1 fact."
    );
  });

  it("wraps invalid-json previews across multiple recent-activity lines", async () => {
    const snapshot: OmStatusSnapshot = {
      counts: {
        stableFacts: 0,
        activeThreads: 0,
        observations: 0,
        reflections: 0,
      },
      recentEvents: [
        {
          createdAt: "2026-04-05T00:00:03.000Z",
          level: "warning",
          message:
            'OM observer returned invalid JSON for 1 pending entry. [model=openai-codex/gpt-5.4 stop=stop parts=1 textParts=1 textChars=92 types=text preview="{\"observations\":[{\"kind\":\"fact\",\"summary\":\"A very long structured response preview that should wrap across multiple lines in the overlay.\"}]}" ]',
        },
      ],
      lastProcessedEntryId: null,
      restore: "none",
      updatedAt: "2026-04-05T00:00:00.000Z",
      observer: {
        status: "noop",
        reason: "threshold-not-met",
        pendingEntryCount: 0,
        pendingTurnCount: 0,
        pendingTokens: 0,
        thresholdTokens: 100,
        blockAfterTokens: 120,
        bufferTokens: 0,
        bufferThresholdTokens: 80,
        bufferStatus: "none",
        bufferSourceCount: 0,
      },
      reflector: {
        status: "noop",
        reason: "threshold-not-met",
        retainedObservationCount: 0,
        retainedObservationTokens: 0,
        thresholdTokens: 100,
        blockAfterTokens: 120,
        observationsToReflectCount: 0,
        bufferTokens: 0,
        bufferThresholdTokens: 50,
        bufferStatus: "none",
        bufferSourceCount: 0,
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

    const rendered = renders[0]?.join("\n") ?? "";
    expect(rendered).toContain("preview=");
    expect(rendered).toContain('  "{"observations"');
    expect(rendered).toContain("multiple lines in the overlay.");
  });

  it("renders a compact failure summary in the overlay", async () => {
    const snapshot: OmStatusSnapshot = {
      counts: {
        stableFacts: 0,
        activeThreads: 0,
        observations: 0,
        reflections: 0,
      },
      recentEvents: [
        {
          createdAt: "2026-04-05T00:00:01.000Z",
          level: "warning",
          message:
            "OM observer skipped 1 pending entry: no observer model available.",
        },
        {
          createdAt: "2026-04-05T00:00:02.000Z",
          level: "warning",
          message: "OM observer returned invalid JSON for 1 pending entry.",
        },
        {
          createdAt: "2026-04-05T00:00:03.000Z",
          level: "warning",
          message: "OM observation buffer returned invalid JSON for 1 entry.",
        },
      ],
      lastProcessedEntryId: null,
      restore: "none",
      updatedAt: "2026-04-05T00:00:00.000Z",
      observer: {
        status: "noop",
        reason: "threshold-not-met",
        pendingEntryCount: 0,
        pendingTurnCount: 0,
        pendingTokens: 0,
        thresholdTokens: 100,
        blockAfterTokens: 120,
        bufferTokens: 0,
        bufferThresholdTokens: 80,
        bufferStatus: "none",
        bufferSourceCount: 0,
      },
      reflector: {
        status: "noop",
        reason: "threshold-not-met",
        retainedObservationCount: 0,
        retainedObservationTokens: 0,
        thresholdTokens: 100,
        blockAfterTokens: 120,
        observationsToReflectCount: 0,
        bufferTokens: 0,
        bufferThresholdTokens: 50,
        bufferStatus: "none",
        bufferSourceCount: 0,
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

    expect(renders[0]?.join("\n")).toContain("Recent failures");
    expect(renders[0]?.join("\n")).toContain("invalid-json × 2");
    expect(renders[0]?.join("\n")).toContain("missing-model × 1");
  });
});
