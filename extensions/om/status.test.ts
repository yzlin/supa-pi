import { describe, expect, it } from "bun:test";

import { Key } from "@mariozechner/pi-tui";

import {
  formatOmStatusSummary,
  type OmStatusSnapshot,
  showOmStatusView,
} from "./status";

const TEST_THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

type OmStatusComponent = {
  render(width: number): string[];
  handleInput(data: string): void;
};

function createSnapshot(
  overrides: Partial<OmStatusSnapshot> = {}
): OmStatusSnapshot {
  return {
    counts: {
      stableFacts: 0,
      activeThreads: 0,
      observations: 0,
      reflections: 0,
    },
    entities: {
      stableFacts: [],
      activeThreads: [],
      observations: [],
      reflections: [],
    },
    recentEvents: [],
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
    ...overrides,
  };
}

async function renderInteractiveSnapshot(
  snapshot: OmStatusSnapshot,
  theme: typeof TEST_THEME = TEST_THEME
): Promise<{
  renders: string[][];
  component: OmStatusComponent;
  rerender(width?: number): string;
}> {
  const renders: string[][] = [];
  let component: OmStatusComponent | null = null;

  await showOmStatusView(
    {
      hasUI: true,
      ui: {
        notify() {},
        async custom(factory: any) {
          const nextComponent = factory(
            {
              requestRender() {},
            },
            theme,
            {},
            () => {}
          ) as OmStatusComponent;

          component = nextComponent;
          renders.push(nextComponent.render(80));
        },
      },
    } as any,
    snapshot
  );

  expect(component).not.toBeNull();
  if (!component) {
    throw new Error("Expected OM status component to render");
  }

  const renderedComponent: OmStatusComponent = component;

  return {
    renders,
    component: renderedComponent,
    rerender(width = 80) {
      const next = renderedComponent.render(width);
      renders.push(next);
      return next.join("\n");
    },
  };
}

describe("om status view", () => {
  it("summarizes repeated recent failure reasons compactly", () => {
    const snapshot = createSnapshot({
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
    });

    expect(formatOmStatusSummary(snapshot)).toContain(
      "failures=invalid-json×2, missing-model×1"
    );
  });

  it("renders the overview overlay with status metrics and activity", async () => {
    const snapshot = createSnapshot({
      counts: {
        stableFacts: 1,
        activeThreads: 1,
        observations: 2,
        reflections: 1,
      },
      entities: {
        stableFacts: [
          {
            id: "fact-1",
            text: "User prefers minimal diffs.",
            sourceEntryIds: ["entry-1"],
            updatedAt: "2026-04-05T00:00:00.000Z",
          },
        ],
        activeThreads: [
          {
            id: "thread-1",
            title: "Finish OM continuation",
            status: "active",
            summary: "Keep the status overlay useful after compaction.",
            sourceEntryIds: ["entry-2"],
            updatedAt: "2026-04-05T00:00:00.000Z",
          },
        ],
        observations: [
          {
            id: "obs-1",
            kind: "fact",
            summary: "User wants a browsable OM status view.",
            sourceEntryIds: ["entry-1"],
            createdAt: "2026-04-05T00:00:00.000Z",
          },
          {
            id: "obs-2",
            kind: "decision",
            summary: "Add navigation before adding more OM commands.",
            sourceEntryIds: ["entry-2"],
            createdAt: "2026-04-05T00:00:01.000Z",
          },
        ],
        reflections: [
          {
            id: "refl-1",
            summary: "Status needs both metrics and inspectable content.",
            sourceObservationIds: ["obs-1", "obs-2"],
            createdAt: "2026-04-05T00:00:02.000Z",
          },
        ],
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
    });

    const view = await renderInteractiveSnapshot(snapshot);
    const rendered = view.renders[0]?.join("\n") ?? "";

    expect(rendered).toContain("Observational Memory Status");
    expect(rendered).toContain("Overview");
    expect(rendered).toContain("Buffered observation");
    expect(rendered).toContain("Buffered reflection");
    expect(rendered).toContain("Continuation");
    expect(rendered).toContain("Finish OM continuation coverage.");
    expect(rendered).toContain("Recent activity");
    expect(rendered).toContain("OM observer applied: +1 observation, +1 fact.");
    expect(rendered).toContain("←→/tab tabs");
  });

  it("styles the OM frame like the pieditor file picker", async () => {
    const styledTheme: typeof TEST_THEME = {
      fg(color: string, text: string) {
        return `<${color}:${text}>`;
      },
      bold(text: string) {
        return text;
      },
    };

    const view = await renderInteractiveSnapshot(createSnapshot(), styledTheme);
    const rendered = view.renders[0]?.join("\n") ?? "";

    expect(rendered).toContain("<dim:╭");
    expect(rendered).toContain("<dim:│>");
    expect(rendered).toContain("Observational Memory Status");
  });

  it("navigates across OM entity tabs and shows selected content", async () => {
    const snapshot = createSnapshot({
      counts: {
        stableFacts: 2,
        activeThreads: 1,
        observations: 2,
        reflections: 1,
      },
      entities: {
        stableFacts: [
          {
            id: "fact-1",
            text: "User prefers minimal diffs.",
            sourceEntryIds: ["entry-1"],
            updatedAt: "2026-04-05T00:00:00.000Z",
          },
          {
            id: "fact-2",
            text: "User wants entity navigation in /om status.",
            sourceEntryIds: ["entry-2", "entry-3"],
            updatedAt: "2026-04-05T00:00:05.000Z",
          },
        ],
        activeThreads: [
          {
            id: "thread-1",
            title: "Ship OM browser",
            status: "active",
            summary: "Keep summary metrics but add inspectable entities.",
            sourceEntryIds: ["entry-4"],
            updatedAt: "2026-04-05T00:00:10.000Z",
          },
        ],
        observations: [
          {
            id: "obs-1",
            kind: "fact",
            summary: "The current overlay only closes today.",
            sourceEntryIds: ["entry-1"],
            createdAt: "2026-04-05T00:00:20.000Z",
          },
          {
            id: "obs-2",
            kind: "decision",
            summary: "Reuse tab-like navigation inside /om status.",
            sourceEntryIds: ["entry-2", "entry-3"],
            createdAt: "2026-04-05T00:00:30.000Z",
          },
        ],
        reflections: [
          {
            id: "refl-1",
            summary: "A tabbed browser keeps status and content in one place.",
            sourceObservationIds: ["obs-1", "obs-2"],
            createdAt: "2026-04-05T00:00:40.000Z",
          },
        ],
      },
    });

    const view = await renderInteractiveSnapshot(snapshot);

    view.component.handleInput(Key.right);
    let rendered = view.rerender();
    expect(rendered).toContain("Facts (2)");
    expect(rendered).toContain("User prefers minimal diffs.");
    expect(rendered).toContain("Source entries");

    view.component.handleInput(Key.down);
    rendered = view.rerender();
    expect(rendered).toContain("fact-2");
    expect(rendered).toContain("User wants entity navigation in /om status.");

    view.component.handleInput(Key.right);
    rendered = view.rerender();
    expect(rendered).toContain("Threads (1)");
    expect(rendered).toContain("Ship OM browser");
    expect(rendered).toContain(
      "Keep summary metrics but add inspectable entities."
    );

    view.component.handleInput(Key.right);
    rendered = view.rerender();
    expect(rendered).toContain("Observations (2)");
    expect(rendered).toContain("kind fact");

    view.component.handleInput(Key.down);
    rendered = view.rerender();
    expect(rendered).toContain("obs-2");
    expect(rendered).toContain("Reuse tab-like navigation inside /om status.");

    view.component.handleInput(Key.right);
    rendered = view.rerender();
    expect(rendered).toContain("Reflections (1)");
    expect(rendered).toContain(
      "A tabbed browser keeps status and content in one place."
    );
    expect(rendered).toContain("Source observations");
  });

  it("wraps invalid-json previews across multiple recent-activity lines", async () => {
    const snapshot = createSnapshot({
      recentEvents: [
        {
          createdAt: "2026-04-05T00:00:03.000Z",
          level: "warning",
          message:
            'OM observer returned invalid JSON for 1 pending entry. [model=openai-codex/gpt-5.5 stop=stop parts=1 textParts=1 textChars=92 types=text preview="{\"observations\":[{\"kind\":\"fact\",\"summary\":\"A very long structured response preview that should wrap across multiple lines in the overlay.\"}]}" ]',
        },
      ],
    });

    const view = await renderInteractiveSnapshot(snapshot);
    const rendered = view.renders[0]?.join("\n") ?? "";

    expect(rendered).toContain("preview=");
    expect(rendered).toContain('  "{"observations"');
    expect(rendered).toContain("multiple lines in the overlay.");
  });

  it("renders a compact failure summary in the overview overlay", async () => {
    const snapshot = createSnapshot({
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
    });

    const view = await renderInteractiveSnapshot(snapshot);
    const rendered = view.renders[0]?.join("\n") ?? "";

    expect(rendered).toContain("Recent failures");
    expect(rendered).toContain("invalid-json × 2");
    expect(rendered).toContain("missing-model × 1");
  });
});
