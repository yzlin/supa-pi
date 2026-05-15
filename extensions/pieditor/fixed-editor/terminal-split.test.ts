import { afterEach, describe, expect, it } from "bun:test";

import type { FixedEditorClusterRender } from "./cluster";
import {
  acquireReplacementSurfaceLease,
  attachReplacementLeaseCompositor,
  clearReplacementSurfaceLeases,
} from "./replacement-lease";
import {
  buildFixedClusterPaint,
  calculateRootScrollbarThumb,
  moveCursor,
  resetScrollRegion,
  setScrollRegion,
  type TerminalLike,
  TerminalSplitCompositor,
  type TuiLike,
} from "./terminal-split";

class MockTerminal implements TerminalLike {
  columns = 20;
  private readonly rawRows: number;
  kittyProtocolActive = false;
  readonly writes: string[] = [];

  constructor(rows = 6) {
    this.rawRows = rows;
  }

  get rows(): number {
    return this.rawRows;
  }

  write(data: string): void {
    this.writes.push(data);
  }
}

interface MockTui extends TuiLike {
  listeners: Array<
    (data: string) => { consume?: boolean; data?: string } | undefined
  >;
  requestRenderCount: number;
  overlayVisible: boolean;
}

function createTui(rootLines: string[] = []): MockTui {
  const tui: MockTui = {
    listeners: [],
    requestRenderCount: 0,
    overlayVisible: false,
    hardwareCursorRow: 2,
    previousViewportTop: 0,
    render: () => rootLines,
    doRender: () => undefined,
    addInputListener(listener) {
      this.listeners.push(listener);
      return () => {
        const index = this.listeners.indexOf(listener);
        if (index !== -1) {
          this.listeners.splice(index, 1);
        }
      };
    },
    requestRender() {
      this.requestRenderCount += 1;
    },
    hasOverlay() {
      return this.overlayVisible;
    },
    compositeLineAt(baseLine) {
      return baseLine;
    },
  };
  return tui;
}

const ROOT_SCROLLBAR_TRACK = "\x1b[2;90m█\x1b[0m";
const ROOT_SCROLLBAR_THUMB = "\x1b[97m█\x1b[0m";
const ROOT_SCROLLBAR_PATTERN = new RegExp(
  ` *${String.raw`\x1b`}\\[(?:2;90|97)m█${String.raw`\x1b`}\\[0m$`
);

function rootContent(lines: string[] | undefined): string[] {
  return (lines ?? []).map((line) => line.replace(ROOT_SCROLLBAR_PATTERN, ""));
}

function scrollbarColumn(lines: string[] | undefined): string[] {
  return (lines ?? []).map((line) =>
    line.endsWith(ROOT_SCROLLBAR_THUMB)
      ? ROOT_SCROLLBAR_THUMB
      : ROOT_SCROLLBAR_TRACK
  );
}

function createCompositor(
  options: {
    rootLines?: string[];
    cluster?: FixedEditorClusterRender;
    terminalRows?: number;
    mouseScroll?: boolean;
    hasHardwareCursor?: boolean;
    onCopySelection?: (text: string) => void;
    renderCluster?: (
      width: number,
      terminalRows: number
    ) => FixedEditorClusterRender;
  } = {}
): {
  compositor: TerminalSplitCompositor;
  terminal: MockTerminal;
  tui: MockTui;
} {
  const terminal = new MockTerminal(options.terminalRows ?? 6);
  const tui = createTui(options.rootLines ?? []);
  const cluster = options.cluster ?? {
    lines: ["cluster-a", "cluster-b"],
    cursor: null,
  };
  const compositor = new TerminalSplitCompositor({
    tui,
    terminal,
    mouseScroll: options.mouseScroll,
    onCopySelection: options.onCopySelection,
    getShowHardwareCursor: () => options.hasHardwareCursor ?? false,
    renderCluster: options.renderCluster ?? (() => cluster),
  });

  return { compositor, terminal, tui };
}

describe("terminal split compositor", () => {
  afterEach(() => {
    clearReplacementSurfaceLeases();
    attachReplacementLeaseCompositor(null);
  });
  it("uses raw terminal rows while rendering a replacement surface", () => {
    const { compositor, terminal } = createCompositor({ terminalRows: 10 });
    expect(compositor.install()).toBe(true);
    attachReplacementLeaseCompositor(compositor);

    acquireReplacementSurfaceLease({
      owner: "questionnaire",
      id: "custom-ui",
      target: {
        render: () => [`rows:${terminal.rows}`],
      },
    });

    expect(terminal.rows).toBe(9);
  });

  it("builds cluster paint with cursor placement", () => {
    const paint = buildFixedClusterPaint(
      { lines: ["one", "two"], cursor: { row: 1, col: 2 } },
      5,
      20,
      true
    );

    expect(paint).toContain(resetScrollRegion());
    expect(paint).toContain(
      `${moveCursor(4, 1)}\x1b[0m\x1b[2K\x1b[0mone\x1b[0m`
    );
    expect(paint).toContain(
      `${moveCursor(5, 1)}\x1b[0m\x1b[2K\x1b[0mtwo\x1b[0m`
    );
    expect(paint).toContain(moveCursor(5, 3));
    expect(paint).toContain("\x1b[?25h");
  });

  it("strips unsafe terminal controls from fixed cluster paint", () => {
    const paint = buildFixedClusterPaint(
      {
        lines: [
          "safe\u001b]52;c;YmFk\u0007text\u001b[31mred\u001b[0m\u001b[2Jdone",
        ],
        cursor: null,
      },
      5,
      80,
      false
    );

    expect(paint).toContain("safetext\u001b[31mred\u001b[0mdone");
    expect(paint).not.toContain("\u001b]52");
    expect(paint).not.toContain("\u001b[2J");
  });

  it("calculates root scrollbar thumb positions", () => {
    expect(
      calculateRootScrollbarThumb({
        totalLines: 2,
        viewportRows: 4,
        scrollOffset: 0,
      })
    ).toBeNull();
    expect(
      calculateRootScrollbarThumb({
        totalLines: 6,
        viewportRows: 3,
        scrollOffset: 0,
      })
    ).toEqual({ start: 2, size: 1 });
    expect(
      calculateRootScrollbarThumb({
        totalLines: 6,
        viewportRows: 3,
        scrollOffset: 3,
      })
    ).toEqual({ start: 0, size: 1 });
  });

  it("reserves a root scrollbar column when content does not overflow", () => {
    const { compositor, tui } = createCompositor({
      rootLines: ["short", "tail"],
      terminalRows: 6,
    });
    expect(compositor.install()).toBe(true);

    const lines = tui.render?.(20);

    expect(rootContent(lines)).toEqual(["short", "tail", "", ""]);
    expect(scrollbarColumn(lines)).toEqual([
      ROOT_SCROLLBAR_TRACK,
      ROOT_SCROLLBAR_TRACK,
      ROOT_SCROLLBAR_TRACK,
      ROOT_SCROLLBAR_TRACK,
    ]);
    expect(lines?.every((line) => line.endsWith(ROOT_SCROLLBAR_TRACK))).toBe(
      true
    );
  });

  it("renders the root scrollbar thumb at the bottom", () => {
    const { compositor, tui } = createCompositor({
      rootLines: ["root-1", "root-2", "root-3", "root-4", "root-5", "root-6"],
      terminalRows: 5,
    });
    expect(compositor.install()).toBe(true);

    const lines = tui.render?.(20);

    expect(rootContent(lines)).toEqual(["root-4", "root-5", "root-6"]);
    expect(scrollbarColumn(lines)).toEqual([
      ROOT_SCROLLBAR_TRACK,
      ROOT_SCROLLBAR_TRACK,
      ROOT_SCROLLBAR_THUMB,
    ]);
  });

  it("renders the root scrollbar thumb when scrolled up", () => {
    const { compositor, tui } = createCompositor({
      rootLines: ["root-1", "root-2", "root-3", "root-4", "root-5", "root-6"],
      terminalRows: 5,
    });
    expect(compositor.install()).toBe(true);
    tui.render?.(20);

    expect(tui.listeners[0]?.("\u001b[1;9A")).toEqual({ consume: true });
    const lines = tui.render?.(20);

    expect(rootContent(lines)).toEqual(["root-1", "root-2", "root-3"]);
    expect(scrollbarColumn(lines)).toEqual([
      ROOT_SCROLLBAR_THUMB,
      ROOT_SCROLLBAR_TRACK,
      ROOT_SCROLLBAR_TRACK,
    ]);
  });

  it("preserves manual root scroll when new content arrives", () => {
    const rootLines = [
      "root-1",
      "root-2",
      "root-3",
      "root-4",
      "root-5",
      "root-6",
    ];
    const { compositor, tui } = createCompositor({
      rootLines,
      terminalRows: 5,
    });
    expect(compositor.install()).toBe(true);
    expect(rootContent(tui.render?.(20))).toEqual([
      "root-4",
      "root-5",
      "root-6",
    ]);
    expect(tui.listeners[0]?.("\u001b[1;9A")).toEqual({ consume: true });
    expect(rootContent(tui.render?.(20))).toEqual([
      "root-1",
      "root-2",
      "root-3",
    ]);

    rootLines.push("root-7", "root-8");

    expect(rootContent(tui.render?.(20))).toEqual([
      "root-1",
      "root-2",
      "root-3",
    ]);
    expect(scrollbarColumn(tui.render?.(20))).toEqual([
      ROOT_SCROLLBAR_THUMB,
      ROOT_SCROLLBAR_TRACK,
      ROOT_SCROLLBAR_TRACK,
    ]);
  });

  it("jumps to root bottom once and follows new content until manual scroll", () => {
    const rootLines = [
      "root-1",
      "root-2",
      "root-3",
      "root-4",
      "root-5",
      "root-6",
    ];
    const { compositor, tui } = createCompositor({
      rootLines,
      terminalRows: 5,
    });
    expect(compositor.install()).toBe(true);
    expect(rootContent(tui.render?.(20))).toEqual([
      "root-4",
      "root-5",
      "root-6",
    ]);
    expect(tui.listeners[0]?.("\u001b[1;9A")).toEqual({ consume: true });
    expect(rootContent(tui.render?.(20))).toEqual([
      "root-1",
      "root-2",
      "root-3",
    ]);

    expect(compositor.jumpToRootBottom()).toBe(true);
    expect(rootContent(tui.render?.(20))).toEqual([
      "root-4",
      "root-5",
      "root-6",
    ]);

    rootLines.push("root-7", "root-8");
    expect(rootContent(tui.render?.(20))).toEqual([
      "root-6",
      "root-7",
      "root-8",
    ]);

    expect(tui.listeners[0]?.("\u001b[1;9A")).toEqual({ consume: true });
    expect(rootContent(tui.render?.(20))).toEqual([
      "root-1",
      "root-2",
      "root-3",
    ]);
    rootLines.push("root-9");
    expect(rootContent(tui.render?.(20))).toEqual([
      "root-1",
      "root-2",
      "root-3",
    ]);
  });

  it("patches renderables and restores them on dispose", () => {
    const { compositor, terminal, tui } = createCompositor({
      rootLines: ["root-a", "root-b", "root-c", "root-d"],
    });
    const renderable = { render: (_width: number) => ["editor"] };

    expect(compositor.install()).toBe(true);
    expect(terminal.rows).toBe(4);
    expect(rootContent(tui.render?.(20))).toEqual([
      "root-a",
      "root-b",
      "root-c",
      "root-d",
    ]);

    compositor.hideRenderable(renderable);
    expect(renderable.render(20)).toEqual([]);
    expect(compositor.renderHidden(renderable, 20)).toEqual(["editor"]);

    compositor.dispose();

    expect(terminal.rows).toBe(6);
    expect(renderable.render(20)).toEqual(["editor"]);
    expect(tui.listeners).toHaveLength(0);
    terminal.writes.splice(0);
    terminal.write("after-dispose");
    expect(terminal.writes).toEqual(["after-dispose"]);
  });

  it("keeps unrelated baseline renderables hidden while a lease is active", () => {
    const baseline = { render: (_width: number) => ["editor"] };
    const replacement = { render: (_width: number) => ["replacement"] };
    const { compositor } = createCompositor();
    expect(compositor.install()).toBe(true);
    attachReplacementLeaseCompositor(compositor);

    compositor.hideRenderable(baseline);
    compositor.hideRenderable(replacement);
    expect(baseline.render(20)).toEqual([]);
    expect(replacement.render(20)).toEqual([]);

    const lease = acquireReplacementSurfaceLease({
      owner: "test",
      id: "replacement",
      target: replacement,
    });
    expect(baseline.render(20)).toEqual([]);
    expect(replacement.render(20)).toEqual(["replacement"]);

    lease.release();

    expect(baseline.render(20)).toEqual([]);
    expect(replacement.render(20)).toEqual([]);

    compositor.unhideRenderable(baseline);
    compositor.unhideRenderable(replacement);
    expect(baseline.render(20)).toEqual(["editor"]);
    expect(replacement.render(20)).toEqual(["replacement"]);
  });

  it("keeps baseline hidden after releasing a lease for the same renderable", () => {
    const renderable = { render: (_width: number) => ["editor"] };
    const { compositor } = createCompositor();
    expect(compositor.install()).toBe(true);
    attachReplacementLeaseCompositor(compositor);

    compositor.hideRenderable(renderable);
    expect(renderable.render(20)).toEqual([]);

    const lease = acquireReplacementSurfaceLease({
      owner: "test",
      id: "same-target",
      target: renderable,
    });
    expect(renderable.render(20)).toEqual(["editor"]);

    lease.release();

    expect(renderable.render(20)).toEqual([]);

    compositor.unhideRenderable(renderable);
    expect(renderable.render(20)).toEqual(["editor"]);
  });

  it("fully repaints fixed cluster after an overlay closes", () => {
    const { compositor, terminal, tui } = createCompositor({
      renderCluster: () => ({
        lines: ["status", "editor-a", "editor-b"],
        cursor: null,
      }),
    });
    expect(compositor.install()).toBe(true);
    terminal.writes.splice(0);

    tui.doRender?.();
    expect(terminal.writes[0]).toContain("editor-a");

    tui.overlayVisible = true;
    expect(tui.render?.(20)).toEqual([]);

    tui.overlayVisible = false;
    terminal.writes.splice(0);
    tui.doRender?.();

    expect(terminal.writes[0]).toContain("status");
    expect(terminal.writes[0]).toContain("editor-a");
    expect(terminal.writes[0]).toContain("editor-b");
  });

  it("lets hidden renderables render normally while an overlay is visible", () => {
    const { compositor, tui } = createCompositor();
    const renderable = { render: (_width: number) => ["editor"] };

    expect(compositor.install()).toBe(true);
    compositor.hideRenderable(renderable);
    expect(renderable.render(20)).toEqual([]);

    tui.overlayVisible = true;
    expect(renderable.render(20)).toEqual(["editor"]);
    expect(compositor.renderHidden(renderable, 20)).toEqual(["editor"]);
  });

  it("wraps terminal writes and repaints the fixed cluster", () => {
    const { compositor, terminal, tui } = createCompositor({
      cluster: { lines: ["status", "editor"], cursor: { row: 1, col: 3 } },
      hasHardwareCursor: true,
    });
    expect(compositor.install()).toBe(true);
    terminal.writes.splice(0);

    terminal.write("payload");

    expect(terminal.writes).toHaveLength(1);
    expect(terminal.writes[0]).toContain(setScrollRegion(1, 4));
    expect(terminal.writes[0]).toContain(moveCursor(3, 1));
    expect(terminal.writes[0]).toContain(
      `${moveCursor(3, 1)}\x1b[0mpayload\x1b[0m`
    );
    expect(terminal.writes[0]).toContain("status");
    expect(terminal.writes[0]).toContain("editor");
    expect(terminal.writes[0]).toContain(moveCursor(6, 4));

    terminal.writes.splice(0);
    terminal.write("first\x1b[2Ksecond\x1b[2Kthird");
    expect(terminal.writes[0]).toContain(
      "first\x1b[0m\x1b[2K\x1b[0msecond\x1b[0m\x1b[2K\x1b[0mthird"
    );

    terminal.writes.splice(0);
    tui.doRender?.();
    expect(terminal.writes).toHaveLength(0);

    compositor.requestRepaint();
    expect(terminal.writes).toHaveLength(0);
  });

  it("repaints only changed fixed cluster lines", () => {
    let statusLine = "status-a";
    const { compositor, terminal, tui } = createCompositor({
      renderCluster: () => ({
        lines: [statusLine, "editor-a", "editor-b"],
        cursor: null,
      }),
    });
    expect(compositor.install()).toBe(true);
    terminal.writes.splice(0);

    tui.doRender?.();
    expect(terminal.writes[0]).toContain("status-a");
    expect(terminal.writes[0]).toContain("editor-a");
    expect(terminal.writes[0]).toContain("editor-b");

    statusLine = "status-b";
    terminal.writes.splice(0);
    tui.doRender?.();

    expect(terminal.writes[0]).toContain("status-b");
    expect(terminal.writes[0]).not.toContain("editor-a");
    expect(terminal.writes[0]).not.toContain("editor-b");
  });

  it("restores the hardware cursor after partial fixed cluster repaint", () => {
    let statusLine = "status-a";
    const { compositor, terminal, tui } = createCompositor({
      hasHardwareCursor: true,
      renderCluster: () => ({
        lines: [statusLine, "editor-a", "editor-b"],
        cursor: { row: 2, col: 4 },
      }),
    });
    expect(compositor.install()).toBe(true);
    terminal.writes.splice(0);

    tui.doRender?.();
    statusLine = "status-b";
    terminal.writes.splice(0);
    tui.doRender?.();

    expect(terminal.writes[0]).toContain("status-b");
    expect(terminal.writes[0]).toContain(moveCursor(6, 5));
    expect(terminal.writes[0]).toContain("\x1b[?25h");
  });

  it("reuses the cached fixed cluster for unrelated terminal writes", () => {
    let renderClusterCount = 0;
    const { compositor, terminal, tui } = createCompositor({
      renderCluster: () => {
        renderClusterCount += 1;
        return { lines: ["status", "editor"], cursor: null };
      },
    });
    expect(compositor.install()).toBe(true);
    terminal.writes.splice(0);

    tui.doRender?.();
    expect(renderClusterCount).toBe(1);

    terminal.write("first payload");
    terminal.write("second payload");

    expect(renderClusterCount).toBe(1);
    expect(terminal.writes).toHaveLength(3);
    expect(terminal.writes[1]).toContain("first payload");
    expect(terminal.writes[1]).toContain(resetScrollRegion());
    expect(terminal.writes[2]).toContain("second payload");
    expect(terminal.writes[2]).toContain(resetScrollRegion());
  });

  it("clears fixed cluster paint when a lease becomes active", () => {
    const renderable = { render: (_width: number) => ["replacement"] };
    const { compositor, terminal, tui } = createCompositor({
      cluster: { lines: ["status", "editor"], cursor: null },
      rootLines: ["root"],
    });
    expect(compositor.install()).toBe(true);
    tui.doRender?.();
    expect(terminal.writes.at(-1)).toContain("editor");
    terminal.writes.splice(0);
    attachReplacementLeaseCompositor(compositor);
    compositor.hideRenderable(renderable);

    const lease = acquireReplacementSurfaceLease({
      owner: "test",
      id: "replacement",
      target: renderable,
    });

    const paint = terminal.writes.join("");
    expect(tui.requestRenderCount).toBe(2);
    expect(paint).toContain("\x1b[2K");
    expect(paint).toContain("replacement");
    expect(terminal.rows).toBe(5);
    expect(renderable.render(20)).toEqual(["replacement"]);
    terminal.write("raw-write");
    const wrappedWrite = terminal.writes.at(-1) ?? "";
    expect(wrappedWrite).toContain(setScrollRegion(1, 5));
    expect(wrappedWrite).toContain("raw-write");

    compositor.requestRepaint();

    lease.release();
  });

  it("caps replacement surfaces to leave one root row", () => {
    const renderable = {
      render: (_width: number) => [
        "replacement-1",
        "replacement-2",
        "replacement-3",
        "replacement-4",
        "replacement-5",
      ],
    };
    const { compositor, terminal } = createCompositor({ terminalRows: 4 });
    expect(compositor.install()).toBe(true);
    attachReplacementLeaseCompositor(compositor);
    terminal.writes.splice(0);

    const lease = acquireReplacementSurfaceLease({
      owner: "test",
      id: "replacement",
      target: renderable,
    });

    const paint = terminal.writes.join("");
    expect(terminal.rows).toBe(1);
    expect(paint).toContain("replacement-1");
    expect(paint).toContain("replacement-3");
    expect(paint).not.toContain("replacement-4");
    expect(paint).not.toContain(moveCursor(5, 1));

    lease.release();
  });

  it("clears stale rows when repainting a shorter replacement surface", () => {
    const renderable = { render: (_width: number) => ["replacement"] };
    const { compositor, terminal, tui } = createCompositor({
      cluster: { lines: ["status", "editor-a", "editor-b"], cursor: null },
    });
    expect(compositor.install()).toBe(true);
    tui.doRender?.();
    terminal.writes.splice(0);
    attachReplacementLeaseCompositor(compositor);

    const lease = acquireReplacementSurfaceLease({
      owner: "test",
      id: "replacement",
      target: renderable,
    });

    const paint = terminal.writes.join("");
    expect(paint).toContain(moveCursor(4, 1));
    expect(paint).toContain(moveCursor(5, 1));
    expect(paint).toContain(moveCursor(6, 1));
    expect(paint).toContain("replacement");

    lease.release();
  });

  it("resets terminal colors when restoring the fixed cluster after a lease releases", () => {
    const reset = "\x1b[0m";
    const borderColor = "\x1b[38;2;102;92;84m";
    const questionnaireColor = "\x1b[38;2;254;128;25m";
    const renderable = {
      render: (_width: number) => [
        `${questionnaireColor}questionnaire${reset}`,
      ],
    };
    const { compositor, terminal, tui } = createCompositor({
      renderCluster: () => ({
        lines: [
          `${borderColor}╭${reset} status ${borderColor}╮${reset}`,
          `${borderColor}│${reset} body ${borderColor}│${reset}`,
        ],
        cursor: null,
      }),
    });
    expect(compositor.install()).toBe(true);
    tui.doRender?.();
    attachReplacementLeaseCompositor(compositor);

    const lease = acquireReplacementSurfaceLease({
      owner: "questionnaire",
      id: "custom-ui",
      target: renderable,
    });

    terminal.writes.splice(0);
    lease.release();

    const restorePaint = terminal.writes.join("");
    expect(restorePaint).toContain(`${reset}\x1b[2K${reset}${borderColor}╭`);
    expect(restorePaint).toContain(`${reset}\x1b[2K${reset}${borderColor}│`);
    expect(restorePaint).toContain(`${borderColor}╭${reset} status`);
    expect(restorePaint).toContain(`${borderColor}│${reset} body`);
  });

  it("reserves root rows and keeps scrollbar chrome while leased", () => {
    const renderable = { render: (_width: number) => ["replacement"] };
    const { compositor, tui } = createCompositor({
      rootLines: ["root-1", "root-2", "root-3", "root-4", "root-5", "root-6"],
      terminalRows: 5,
    });
    expect(compositor.install()).toBe(true);

    const lease = acquireReplacementSurfaceLease({
      owner: "test",
      id: "replacement",
      target: renderable,
    });

    expect(rootContent(tui.render?.(20))).toEqual([
      "root-3",
      "root-4",
      "root-5",
      "root-6",
    ]);
    expect((tui.render?.(20) ?? []).join("\n")).toContain("█");

    lease.release();
  });

  it("keeps root scroll input while leased", () => {
    const renderable = { render: (_width: number) => ["replacement"] };
    const copied: string[] = [];
    const { compositor, terminal, tui } = createCompositor({
      rootLines: ["root-1", "root-2", "root-3", "root-4", "root-5", "root-6"],
      terminalRows: 5,
      onCopySelection: (text) => copied.push(text),
    });
    expect(compositor.install()).toBe(true);
    attachReplacementLeaseCompositor(compositor);

    const lease = acquireReplacementSurfaceLease({
      owner: "test",
      id: "replacement",
      target: renderable,
    });

    expect(tui.listeners[0]?.("\u001b[1;9A")).toEqual({ consume: true });
    expect(tui.listeners[0]?.("\u001b[<64;1;1M")).toEqual({ consume: true });
    expect(
      tui.listeners[0]?.(`\u001b[<2;1;${terminal.rows + 1}M`)
    ).toBeUndefined();
    expect(copied).toEqual([]);
    expect(tui.requestRenderCount).toBeGreaterThan(0);

    lease.release();
  });

  it("leaves writes and input alone while an overlay is visible", () => {
    const { compositor, terminal, tui } = createCompositor({
      rootLines: ["plain", "\u001b]8;;https://example.test\u0007linked"],
    });
    expect(compositor.install()).toBe(true);
    terminal.writes.splice(0);
    tui.overlayVisible = true;

    terminal.write("raw-write");
    compositor.requestRepaint();

    expect(terminal.rows).toBe(6);
    expect(terminal.writes).toEqual(["raw-write"]);
    expect(tui.listeners[0]?.("\u001b[1;9A")).toBeUndefined();
    expect(tui.render?.(20)).toEqual(["plain", "linked"]);
    expect((tui.render?.(20) ?? []).join("\n")).not.toContain("█");
    expect(tui.compositeLineAt?.("a\tb", "c\td", 0, 4, 10)).toBe("a   b");
  });

  it("preserves the fixed-editor root scroll window behind overlays", () => {
    const terminal = new MockTerminal(5);
    const tui = createTui();
    const rootLines = [
      "root-1",
      "root-2",
      "root-3",
      "root-4",
      "root-5",
      "root-6",
    ];
    const clusterLines = ["status", "editor"];
    tui.render = () =>
      tui.overlayVisible ? [...rootLines, ...clusterLines] : rootLines;
    const compositor = new TerminalSplitCompositor({
      tui,
      terminal,
      renderCluster: () => ({ lines: clusterLines, cursor: null }),
    });

    expect(compositor.install()).toBe(true);
    compositor.hideRenderable({ render: () => clusterLines });

    expect(rootContent(tui.render?.(20))).toEqual([
      "root-4",
      "root-5",
      "root-6",
    ]);
    expect(tui.listeners[0]?.("\u001b[1;9A")).toEqual({ consume: true });
    expect(rootContent(tui.render?.(20))).toEqual([
      "root-1",
      "root-2",
      "root-3",
    ]);

    tui.overlayVisible = true;

    expect(tui.render?.(20)).toEqual([
      "root-1",
      "root-2",
      "root-3",
      ...clusterLines,
    ]);
    expect((tui.render?.(20) ?? []).join("\n")).not.toContain("█");
  });

  it("consumes configured keyboard and mouse scroll input", () => {
    const { compositor, tui } = createCompositor({
      rootLines: ["root-1", "root-2", "root-3", "root-4", "root-5", "root-6"],
      terminalRows: 5,
    });
    expect(compositor.install()).toBe(true);

    expect(rootContent(tui.render?.(20))).toEqual([
      "root-4",
      "root-5",
      "root-6",
    ]);
    expect(scrollbarColumn(tui.render?.(20))).toEqual([
      ROOT_SCROLLBAR_TRACK,
      ROOT_SCROLLBAR_TRACK,
      ROOT_SCROLLBAR_THUMB,
    ]);
    expect(tui.listeners[0]?.("\u001b[1;9A")).toEqual({ consume: true });
    expect(tui.requestRenderCount).toBe(1);
    expect(rootContent(tui.render?.(20))).toEqual([
      "root-1",
      "root-2",
      "root-3",
    ]);
    expect(scrollbarColumn(tui.render?.(20))).toEqual([
      ROOT_SCROLLBAR_THUMB,
      ROOT_SCROLLBAR_TRACK,
      ROOT_SCROLLBAR_TRACK,
    ]);

    expect(tui.listeners[0]?.("\u001b[1;9B")).toEqual({ consume: true });
    expect(rootContent(tui.render?.(20))).toEqual([
      "root-4",
      "root-5",
      "root-6",
    ]);

    expect(tui.listeners[0]?.("\u001b[<64;1;1M")).toEqual({ consume: true });
    expect(rootContent(tui.render?.(20))).toEqual([
      "root-1",
      "root-2",
      "root-3",
    ]);
  });

  it("copies selected text through the configured copy callback", () => {
    const copied: string[] = [];
    const { compositor, terminal, tui } = createCompositor({
      cluster: { lines: ["cluster text"], cursor: null },
      onCopySelection: (text) => copied.push(text),
    });
    expect(compositor.install()).toBe(true);
    tui.render?.(20);

    const clusterRow = terminal.rows + 1;
    tui.listeners[0]?.(`\u001b[<0;1;${clusterRow}M`);
    tui.listeners[0]?.(`\u001b[<32;8;${clusterRow}M`);
    tui.listeners[0]?.(`\u001b[<0;8;${clusterRow}m`);

    expect(copied).toEqual(["cluster"]);
  });

  it("does not consume mouse input when mouse scrolling is disabled", () => {
    const { compositor, tui } = createCompositor({ mouseScroll: false });
    expect(compositor.install()).toBe(true);

    expect(tui.listeners[0]?.("\u001b[<64;1;1M")).toBeUndefined();
  });
});
