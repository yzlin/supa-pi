import { describe, expect, it } from "bun:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { CURSOR_MARKER, renderFixedEditorCluster } from "./cluster";

const dim = (value: string) => `\u001b[2m${value}\u001b[0m`;

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

  it("keeps framed editor top border pinned while budgeting body, bottom border, and popup", () => {
    const render = renderFixedEditorCluster({
      width: 20,
      terminalRows: 6,
      editorLines: [
        "╭ status pinned ╮",
        "│ body-1       │",
        `│ body-${CURSOR_MARKER}2       │`,
        "│ body-3       │",
        "╰ path git     ╯",
        "popup-a",
        "popup-b",
      ],
      secondaryLines: ["secondary"],
    });

    expect(render.lines).toEqual([
      "╭ status pinned ╮",
      "│ body-2       │",
      "╰ path git     ╯",
      "popup-a",
      "popup-b",
    ]);
    expect(render.cursor).toEqual({ row: 1, col: 7 });
  });

  it("preserves framed editor cursor when popup rows reduce the body budget", () => {
    const render = renderFixedEditorCluster({
      width: 20,
      terminalRows: 5,
      editorLines: [
        "╭ status pinned ╮",
        "│ body-1       │",
        "│ body-2       │",
        `│ body-${CURSOR_MARKER}3       │`,
        "╰ path git     ╯",
        "popup-a",
      ],
    });

    expect(render.lines).toEqual([
      "╭ status pinned ╮",
      "│ body-3       │",
      "╰ path git     ╯",
      "popup-a",
    ]);
    expect(render.cursor).toEqual({ row: 1, col: 7 });
  });

  it("detects colored framed editor borders while budgeting rows", () => {
    const render = renderFixedEditorCluster({
      width: 30,
      terminalRows: 5,
      editorLines: [
        `${dim("╭")} status pinned ${dim("╮")}`,
        `${dim("│")} body-1 ${dim("│")}`,
        `${dim("│")} body-${CURSOR_MARKER}2 ${dim("│")}`,
        `${dim("╰")} path git ${dim("╯")}`,
        "popup-a",
      ],
    });

    expect(render.lines).toEqual([
      `${dim("╭")} status pinned ${dim("╮")}`,
      `${dim("│")} body-2 ${dim("│")}`,
      `${dim("╰")} path git ${dim("╯")}`,
      "popup-a",
    ]);
    expect(render.cursor).toEqual({ row: 1, col: 7 });
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
