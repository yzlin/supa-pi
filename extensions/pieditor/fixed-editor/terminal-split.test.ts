import { describe, expect, it } from "bun:test";

import type { FixedEditorClusterRender } from "./cluster";
import {
  buildFixedClusterPaint,
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
  it("builds cluster paint with cursor placement", () => {
    const paint = buildFixedClusterPaint(
      { lines: ["one", "two"], cursor: { row: 1, col: 2 } },
      5,
      20,
      true
    );

    expect(paint).toContain(resetScrollRegion());
    expect(paint).toContain(`${moveCursor(4, 1)}\x1b[2Kone`);
    expect(paint).toContain(`${moveCursor(5, 1)}\x1b[2Ktwo`);
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

  it("patches renderables and restores them on dispose", () => {
    const { compositor, terminal, tui } = createCompositor({
      rootLines: ["root-a", "root-b", "root-c", "root-d"],
    });
    const renderable = { render: (_width: number) => ["editor"] };

    expect(compositor.install()).toBe(true);
    expect(terminal.rows).toBe(4);
    expect(tui.render?.(20)).toEqual(["root-a", "root-b", "root-c", "root-d"]);

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
    expect(terminal.writes[0]).toContain("payload");
    expect(terminal.writes[0]).toContain("status");
    expect(terminal.writes[0]).toContain("editor");
    expect(terminal.writes[0]).toContain(moveCursor(6, 4));

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
    expect(tui.compositeLineAt?.("a\tb", "c\td", 0, 4, 10)).toBe("a   b");
  });

  it("consumes configured keyboard and mouse scroll input", () => {
    const { compositor, tui } = createCompositor({
      rootLines: ["root-1", "root-2", "root-3", "root-4", "root-5", "root-6"],
      terminalRows: 5,
    });
    expect(compositor.install()).toBe(true);

    expect(tui.render?.(20)).toEqual(["root-4", "root-5", "root-6"]);
    expect(tui.listeners[0]?.("\u001b[1;9A")).toEqual({ consume: true });
    expect(tui.requestRenderCount).toBe(1);
    expect(tui.render?.(20)).toEqual(["root-1", "root-2", "root-3"]);

    expect(tui.listeners[0]?.("\u001b[1;9B")).toEqual({ consume: true });
    expect(tui.render?.(20)).toEqual(["root-4", "root-5", "root-6"]);

    expect(tui.listeners[0]?.("\u001b[<64;1;1M")).toEqual({ consume: true });
    expect(tui.render?.(20)).toEqual(["root-1", "root-2", "root-3"]);
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
