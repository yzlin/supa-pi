import { describe, expect, it } from "bun:test";

import { visibleWidth } from "@mariozechner/pi-tui";

import { CURSOR_MARKER, renderFixedEditorCluster } from "./cluster";

describe("fixed editor cluster", () => {
  it("budgets rows around the editor before top, secondary, and status lines", () => {
    const render = renderFixedEditorCluster({
      width: 20,
      terminalRows: 6,
      statusLines: ["status-a", "status-b"],
      topLines: ["top-a", "top-b", "top-c"],
      editorLines: ["edit-a", `edit-${CURSOR_MARKER}b`, "edit-c"],
      secondaryLines: ["secondary-a", "secondary-b"],
    });

    expect(render.lines).toEqual([
      "top-b",
      "top-c",
      "edit-a",
      "edit-b",
      "edit-c",
    ]);
    expect(render.cursor).toEqual({ row: 3, col: 5 });
  });

  it("keeps the cursor visible when the editor exceeds the row budget", () => {
    const render = renderFixedEditorCluster({
      width: 20,
      terminalRows: 4,
      editorLines: ["line-1", "line-2", `line-${CURSOR_MARKER}3`, "line-4"],
    });

    expect(render.lines).toEqual(["line-1", "line-2", "line-3"]);
    expect(render.cursor).toEqual({ row: 2, col: 5 });
  });

  it("centers a selected editor row when no cursor marker exists", () => {
    const render = renderFixedEditorCluster({
      width: 20,
      terminalRows: 4,
      editorLines: ["line-1", "line-2", "→ line-3", "line-4", "line-5"],
    });

    expect(render.lines).toEqual(["line-2", "→ line-3", "line-4"]);
    expect(render.cursor).toBeNull();
  });

  it("truncates all cluster lines to the terminal width", () => {
    const render = renderFixedEditorCluster({
      width: 4,
      terminalRows: 6,
      statusLines: ["status-long"],
      topLines: ["top-long"],
      editorLines: ["editor-long"],
      secondaryLines: ["secondary-long"],
    });

    expect(render.lines).toHaveLength(4);
    expect(render.lines.every((line) => visibleWidth(line) <= 4)).toBe(true);
  });

  it("still reserves one editor row in a tiny terminal", () => {
    const render = renderFixedEditorCluster({
      width: 10,
      terminalRows: 1,
      statusLines: ["status"],
      topLines: ["top"],
      editorLines: ["before", `ab${CURSOR_MARKER}c`, "after"],
      secondaryLines: ["secondary"],
    });

    expect(render.lines).toEqual(["abc"]);
    expect(render.cursor).toEqual({ row: 0, col: 2 });
  });
});
