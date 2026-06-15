import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  capturePreviousWriteContent,
  createWriteDiffDetails,
  renderCompactBashCall,
  renderCompactBashResult,
  renderCompactGrepResult,
  renderCompactReadResult,
  renderEditCall,
  renderFinalDiffResult,
  renderWriteCall,
} from "./renderers";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
};

const toolSuccessBgAnsi = "\x1b[48;2;32;35;42m";
const splitAddLeftoverPattern = /^\s*│\s+│ ▌2 │ new2/;
const splitAddOnlyPattern = /^\s+│\s+│ ▌1 │ new/;
const splitRemoveOnlyPattern = /^▌1 │ old\s+│\s+│/;

const tokenTheme = {
  bold: (text: string) => text,
  fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
  getBgAnsi: (token: string) =>
    token === "toolSuccessBg" ? toolSuccessBgAnsi : undefined,
  getFgAnsi: (token: string) => {
    if (token === "toolDiffAdded") {
      return "\x1b[38;2;88;173;88m";
    }
    if (token === "toolDiffRemoved") {
      return "\x1b[38;2;196;98;98m";
    }
    return;
  },
};

const ansiDiffTheme = {
  bold: (text: string) => text,
  fg: (token: string, text: string) => {
    if (token === "toolDiffAdded") {
      return `\x1b[38;2;88;173;88m${text}\x1b[39m`;
    }
    if (token === "toolDiffRemoved") {
      return `\x1b[38;2;196;98;98m${text}\x1b[39m`;
    }
    return text;
  },
  getBgAnsi: tokenTheme.getBgAnsi,
  getFgAnsi: tokenTheme.getFgAnsi,
};

const dimContextTheme = {
  bold: (text: string) => text,
  fg: (token: string, text: string) =>
    token === "toolDiffContext" ? `\x1b[2m${text}\x1b[22m` : text,
};

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = join(
    import.meta.dir,
    `.tmp-renderers-${Date.now()}-${Math.random()}`
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("tool-display renderers", () => {
  test("renders compact bash call and result", () => {
    expect(
      renderCompactBashCall({ command: "echo hello", timeout: 2 }, theme).text
    ).toContain("$ echo hello (2s)");
    expect(
      renderCompactBashResult(
        { content: [{ type: "text", text: "hello\nexit code: 0" }] },
        {},
        theme
      ).text
    ).toContain("done (2 lines)");
  });

  test("renders RTK compaction hint only when enabled", () => {
    const result = {
      content: [{ type: "text", text: "tail\nexit code: 0" }],
      details: {
        rtkCompaction: {
          savedChars: 90,
          originalChars: 120,
          finalChars: 30,
        },
      },
    };

    expect(
      renderCompactBashResult(result, {}, theme, {
        collapsed: true,
        mode: "compact",
        previewLines: 20,
        rtkHints: true,
      }).text
    ).toContain("[compacted by RTK: saved 90 chars, original 120, final 30]");
    expect(
      renderCompactBashResult(result, {}, theme, {
        collapsed: true,
        mode: "compact",
        previewLines: 20,
        rtkHints: false,
      }).text
    ).not.toContain("compacted by RTK");
  });

  test("renders partial and expanded output modes", () => {
    expect(
      renderCompactReadResult(
        { content: [{ type: "text", text: "one\ntwo" }] },
        { isPartial: true },
        theme
      ).text
    ).toBe("reading…");
    expect(
      renderCompactReadResult(
        { content: [{ type: "text", text: "one\ntwo" }] },
        { expanded: true },
        theme
      ).text
    ).toContain("\none\ntwo");
  });

  test("renders compact search limit summary", () => {
    expect(
      renderCompactGrepResult(
        {
          content: [{ type: "text", text: "a\nb" }],
          details: { matchLimitReached: 2 },
        },
        {},
        theme
      ).text
    ).toContain("2 lines [limit 2]");
  });

  test("captures previous write content and renders final diff", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "file.txt"), "old\n", "utf8");

    const previous = capturePreviousWriteContent(cwd, "file.txt");
    const details = createWriteDiffDetails("file.txt", "new\n", previous);

    expect(details.toolDisplay?.writeDiff).toContain("-old");
    expect(details.toolDisplay?.writeDiff).toContain("+new");
    expect(
      renderFinalDiffResult({ content: [], details }, {}, theme).text
    ).toBe("+1 / -1 (rewrote file) line 1");
    expect(
      renderFinalDiffResult({ content: [], details }, { expanded: true }, theme)
        .text
    ).toContain("▌new");
  });

  test("renders expanded diff modes and collapse limits", () => {
    const details = createWriteDiffDetails("file.txt", "new\nmore\n", {
      ok: true,
      content: "old\nless\n",
    });

    const originalColumns = process.stdout.columns;
    try {
      process.stdout.columns = 80;
      expect(
        renderFinalDiffResult(
          { content: [], details },
          { expanded: true },
          theme,
          { collapsed: true, enabled: true, previewLines: 3 }
        ).text
      ).toContain("… 4 diff lines collapsed");

      process.stdout.columns = 120;
      expect(
        renderFinalDiffResult(
          { content: [], details },
          { expanded: true },
          theme,
          { collapsed: true, enabled: true, previewLines: 20 }
        ).text
      ).toContain(" │ ");
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  test("selects diff view by width: split, unified, compact, then summary", () => {
    const details = createWriteDiffDetails("file.txt", "new\n", {
      ok: true,
      content: "old\n",
    });
    const component = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      {
        collapsed: false,
        enabled: true,
        previewLines: 20,
        splitMinWidth: 100,
        viewMode: "auto",
      }
    );

    expect(component.render(120).join("\n")).toContain(" │ ");
    expect(component.render(80).join("\n")).toContain("▌new");
    expect(component.render(9).join("\n")).toContain("+1 / -1");
    expect(component.render(4).join("")).toContain("rewrotefile");
  });

  test("falls back from forced split to unified below split minimum width", () => {
    const details = createWriteDiffDetails("file.txt", "new\n", {
      ok: true,
      content: "old\n",
    });
    const rendered = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      {
        collapsed: false,
        enabled: true,
        previewLines: 20,
        splitMinWidth: 100,
        viewMode: "split",
      }
    )
      .render(80)
      .join("\n");

    expect(rendered).toContain("▌new");
    expect(rendered).not.toContain(" │ ");
  });

  test("sizes expanded split diff to render width", () => {
    const longOld = "old ".repeat(40);
    const longNew = "new ".repeat(40);
    const details = {
      toolDisplay: {
        writeDiff: [
          "--- file.txt",
          "+++ file.txt",
          `-${longOld}`,
          `+${longNew}`,
        ].join("\n"),
        writeSummary: "rewrote file",
      },
    };

    const originalColumns = process.stdout.columns;
    try {
      process.stdout.columns = 180;
      const component = renderFinalDiffResult(
        { content: [], details },
        { expanded: true },
        theme,
        { collapsed: false, enabled: true, previewLines: 20 }
      );

      expect(component.text).toContain(" │ ");

      const rendered = component.render(120);
      expect(rendered).toHaveLength(component.text.split("\n").length);
      expect(rendered.every((line) => line.length === 120)).toBe(true);
    } finally {
      process.stdout.columns = originalColumns;
    }
  });

  test("keeps split placeholder cells aligned for paired changes", () => {
    const details = createWriteDiffDetails("file.txt", "new\n", {
      ok: true,
      content: "old\n",
    });
    const lines = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20 }
    )
      .render(120)
      .filter((line) => line.includes(" │ "));

    expect(lines.some((line) => line.includes("old"))).toBe(true);
    expect(lines.some((line) => line.includes("new"))).toBe(true);
    expect(new Set(lines.map((line) => line.length))).toEqual(new Set([120]));
  });

  test("pairs replacement runs and leaves unequal split leftovers blank", () => {
    const details = createWriteDiffDetails("file.txt", "new1\nnew2\n", {
      ok: true,
      content: "old1\n",
    });
    const rendered = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "split" }
    ).render(140);

    expect(rendered).toContainEqual(expect.stringContaining("▌1 │ old1"));
    expect(rendered).toContainEqual(expect.stringContaining("▌1 │ new1"));
    expect(rendered).toContainEqual(
      expect.stringMatching(splitAddLeftoverPattern)
    );
  });

  test("renders add-only and remove-only split rows with blank opposite cells", () => {
    const removeOnly = renderFinalDiffResult(
      {
        content: [],
        details: { diff: "--- a\n+++ a\n@@ -1,1 +0,0 @@\n-old" },
      },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "split" }
    ).render(140);
    const addOnly = renderFinalDiffResult(
      {
        content: [],
        details: { diff: "--- a\n+++ a\n@@ -0,0 +1,1 @@\n+new" },
      },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "split" }
    ).render(140);

    expect(removeOnly).toContainEqual(
      expect.stringMatching(splitRemoveOnlyPattern)
    );
    expect(addOnly).toContainEqual(expect.stringMatching(splitAddOnlyPattern));
  });

  test("themes blank split cells like context cells", () => {
    const rendered = renderFinalDiffResult(
      {
        content: [],
        details: { diff: "--- a\n+++ a\n@@ -0,0 +1,1 @@\n+new" },
      },
      { expanded: true },
      dimContextTheme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "split" }
    )
      .render(140)
      .join("\n");

    expect(rendered).toContain("\x1b[2m");
    expect(rendered).toContain("│");
    expect(rendered).toContain("\x1b[22m");
  });

  test("renders split meta and path rows as single full-width rows", () => {
    const rendered = renderFinalDiffResult(
      {
        content: [],
        details: {
          diff: "--- file.txt\n+++ file.txt\n@@ -1,2 +1,2 @@\n unchanged\n-old\n+new",
        },
      },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "split" }
    ).render(140);

    expect(rendered[1]?.trim()).toBe("file.txt");
    expect(rendered[2]?.trim()).toBe("@@ -1,2 +1,2 @@");
    expect(rendered[1]).not.toContain(" │ ");
    expect(rendered[2]).not.toContain(" │ ");
  });

  test("renders changed split path rows old-to-new", () => {
    const rendered = renderFinalDiffResult(
      {
        content: [],
        details: {
          diff: "--- old.txt\n+++ new.txt\n@@ -1,1 +1,1 @@\n-old\n+new",
        },
      },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "split" }
    ).render(140);

    expect(rendered[1]?.trim()).toBe("old.txt → new.txt");
    expect(rendered[1]).not.toContain(" │ ");
  });

  test("widens split gutters for larger context row line numbers", () => {
    const rendered = renderFinalDiffResult(
      {
        content: [],
        details: {
          diff: "--- a\n+++ a\n@@ -98,3 +98,3 @@\n same\n-old\n+new\n tail",
        },
      },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "split" }
    )
      .render(140)
      .join("\n");

    expect(rendered).toContain("  98 │ same");
    expect(rendered).toContain("▌ 99 │ old");
    expect(rendered).toContain(" 100 │ tail");
  });

  test("uses headerless edit diff line numbers as split gutters", () => {
    const rendered = renderFinalDiffResult(
      {
        content: [],
        details: {
          diff: " 3 > This file extends docs\n-17 old plan\n+19 new plan",
        },
      },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "split" }
    )
      .render(140)
      .join("\n");

    expect(rendered).toContain(" 3 │ > This file extends docs");
    expect(rendered).toContain("▌17 │ old plan");
    expect(rendered).toContain("▌19 │ new plan");
    expect(rendered).not.toContain("│ 3 > This file extends docs");
    expect(rendered).not.toContain("│ 17 old plan");
    expect(rendered).not.toContain("│ 19 new plan");
  });

  test("preserves headerless edit diff line numbers in unified view", () => {
    const rendered = renderFinalDiffResult(
      {
        content: [],
        details: {
          diff: " 3 > This file extends docs\n-17 old plan\n+19 new plan",
        },
      },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "unified" }
    )
      .render(80)
      .join("\n");

    expect(rendered).toContain(" 3 > This file extends docs");
    expect(rendered).toContain("▌17 old plan");
    expect(rendered).toContain("▌19 new plan");
    expect(rendered).not.toContain("▌old plan");
    expect(rendered).not.toContain("▌new plan");
  });

  test("leaves headerless skipped-context rows unnumbered", () => {
    const rendered = renderFinalDiffResult(
      {
        content: [],
        details: {
          diff: " 3 before\n    ...\n 19 after",
        },
      },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "split" }
    )
      .render(140)
      .join("\n");

    expect(rendered).toContain(" 3 │ before");
    expect(rendered).toContain("19 │ after");
    expect(rendered).toContain("│    ...");
    expect(rendered).not.toContain(" 4 │    ...");
    expect(rendered).not.toContain(" 1 │    ...");
  });

  test("preserves line numbers only on the first rendered split row", () => {
    const details = createWriteDiffDetails(
      "file.txt",
      `${"new ".repeat(30)}\n`,
      { ok: true, content: `${"old ".repeat(30)}\n` }
    );
    const rendered = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20 }
    ).render(120);

    expect(rendered.filter((line) => line.includes("▌1 │ old"))).toHaveLength(
      1
    );
    expect(rendered.filter((line) => line.includes("▌1 │ new"))).toHaveLength(
      1
    );
    expect(rendered.some((line) => line.includes("   │ old"))).toBe(true);
    expect(rendered.some((line) => line.includes("   │ new"))).toBe(true);
  });

  test("honors unified diff indicator modes", () => {
    const details = createWriteDiffDetails("file.txt", "new\n", {
      ok: true,
      content: "old\n",
    });

    const bars = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      {
        collapsed: false,
        enabled: true,
        previewLines: 20,
        viewMode: "unified",
        wordWrap: false,
      }
    )
      .render(80)
      .join("\n");
    const classic = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      {
        collapsed: false,
        enabled: true,
        indicatorMode: "classic",
        previewLines: 20,
        viewMode: "unified",
        wordWrap: false,
      }
    )
      .render(80)
      .join("\n");
    const none = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      {
        collapsed: false,
        enabled: true,
        indicatorMode: "none",
        previewLines: 20,
        viewMode: "unified",
        wordWrap: false,
      }
    )
      .render(80)
      .join("\n");

    expect(bars).toContain("▌old");
    expect(bars).toContain("▌new");
    expect(bars).not.toContain("-old");
    expect(bars).not.toContain("+new");
    expect(classic).toContain("-old");
    expect(classic).toContain("+new");
    expect(none).toContain("old");
    expect(none).toContain("new");
    expect(none).not.toContain("▌old");
    expect(none).not.toContain("▌new");
    expect(none).not.toContain("-old");
    expect(none).not.toContain("+new");
  });

  test("honors split diff indicator modes", () => {
    const details = createWriteDiffDetails("file.txt", "new\n", {
      ok: true,
      content: "old\n",
    });

    const bars = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      {
        collapsed: false,
        enabled: true,
        previewLines: 20,
        viewMode: "split",
        wordWrap: false,
      }
    )
      .render(140)
      .join("\n");
    const classic = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      {
        collapsed: false,
        enabled: true,
        indicatorMode: "classic",
        previewLines: 20,
        viewMode: "split",
        wordWrap: false,
      }
    )
      .render(140)
      .join("\n");
    const none = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      {
        collapsed: false,
        enabled: true,
        indicatorMode: "none",
        previewLines: 20,
        viewMode: "split",
        wordWrap: false,
      }
    )
      .render(140)
      .join("\n");

    expect(bars).toContain("▌1 │ old");
    expect(bars).toContain("▌1 │ new");
    expect(bars).not.toContain("-1 │ old");
    expect(bars).not.toContain("+1 │ new");
    expect(classic).toContain("-1 │ old");
    expect(classic).toContain("+1 │ new");
    expect(none).toContain("1 │ old");
    expect(none).toContain("1 │ new");
    expect(none).not.toContain("▌1 │ old");
    expect(none).not.toContain("▌1 │ new");
    expect(none).not.toContain("-1 │ old");
    expect(none).not.toContain("+1 │ new");
  });

  test("reserves bar indicator space on context rows", () => {
    const details = {
      diff: "--- file.txt\n+++ file.txt\n@@ -1,2 +1,2 @@\n unchanged\n-old\n+new",
    };

    const unified = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      {
        collapsed: false,
        enabled: true,
        previewLines: 20,
        viewMode: "unified",
        wordWrap: false,
      }
    )
      .render(80)
      .join("\n");
    const split = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      {
        collapsed: false,
        enabled: true,
        previewLines: 20,
        viewMode: "split",
        wordWrap: false,
      }
    )
      .render(140)
      .join("\n");

    expect(unified).toContain("\n unchanged");
    expect(unified).toContain("\n▌old");
    expect(split).toContain(" 1 │ unchanged");
    expect(split).toContain("▌2 │ old");
  });

  test("wraps split diff continuation rows when wordWrap is true", () => {
    const details = createWriteDiffDetails(
      "file.txt",
      `${"new ".repeat(30)}\n`,
      { ok: true, content: `${"old ".repeat(30)}\n` }
    );

    const rendered = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      {
        collapsed: false,
        enabled: true,
        previewLines: 20,
        viewMode: "split",
        wordWrap: true,
      }
    ).render(120);

    expect(rendered.filter((line) => line.includes("▌1 │ old"))).toHaveLength(
      1
    );
    expect(rendered.some((line) => line.includes("   │ old"))).toBe(true);
  });

  test("clamps split diff rows when wordWrap is false", () => {
    const details = createWriteDiffDetails(
      "file.txt",
      `${"new ".repeat(30)}\n`,
      { ok: true, content: `${"old ".repeat(30)}\n` }
    );

    const rendered = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      {
        collapsed: false,
        enabled: true,
        previewLines: 20,
        viewMode: "split",
        wordWrap: false,
      }
    ).render(120);

    expect(rendered.filter((line) => line.includes("▌1 │ old"))).toHaveLength(
      1
    );
    expect(rendered.some((line) => line.includes("   │ old"))).toBe(false);
  });

  test("captures new file, overwritten file, outside-workspace, and large fallback", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "old.txt"), "old", "utf8");
    writeFileSync(join(cwd, "large.txt"), "x".repeat(512 * 1024 + 1), "utf8");

    expect(capturePreviousWriteContent(cwd, "new.txt")).toEqual({
      ok: true,
      content: null,
    });
    expect(capturePreviousWriteContent(cwd, "old.txt")).toEqual({
      ok: true,
      content: "old",
    });
    expect(capturePreviousWriteContent(cwd, "../outside.txt")).toEqual({
      ok: false,
      summary: "previous content unavailable: outside workspace",
    });
    const large = capturePreviousWriteContent(cwd, "large.txt");
    expect(large.ok).toBe(false);
    expect(large.ok ? "" : large.summary).toContain(
      "previous content too large"
    );
    expect(large.ok ? "" : large.summary.length).toBeLessThan(260);
  });

  test("falls back to write summary when previous content cannot be captured", () => {
    const details = createWriteDiffDetails("file.txt", "new", {
      ok: false,
      summary: "previous content unavailable: nope",
    });

    expect(details.toolDisplay?.writeSummary).toBe(
      "previous content unavailable: nope"
    );
    expect(
      renderFinalDiffResult({ content: [], details }, {}, theme).text
    ).toBe("previous content unavailable: nope");
  });

  test("uses LCS write diffs instead of positional overwrite diffs", () => {
    const details = createWriteDiffDetails("file.txt", "keep\ninsert\nsame\n", {
      ok: true,
      content: "keep\nsame\n",
    });

    expect(details.toolDisplay?.writeDiff).toContain(" keep");
    expect(details.toolDisplay?.writeDiff).toContain("+insert");
    expect(details.toolDisplay?.writeDiff).toContain(" same");
    expect(details.toolDisplay?.writeDiff).not.toContain("-same");
  });

  test("omits detailed overwrite diff when LCS guard trips", () => {
    const oldContent = Array.from(
      { length: 1001 },
      (_, index) => `old ${index}`
    ).join("\n");
    const nextContent = Array.from(
      { length: 1000 },
      (_, index) => `new ${index}`
    ).join("\n");
    const details = createWriteDiffDetails("file.txt", nextContent, {
      ok: true,
      content: oldContent,
    });

    expect(details.toolDisplay?.writeDiff).toBeUndefined();
    expect(details.toolDisplay?.writeSummary).toBe(
      "rewrote file; detailed diff omitted (1001 old lines, 1000 new lines)"
    );
  });

  test("renders inline word highlights for paired changed lines", () => {
    const details = createWriteDiffDetails("file.txt", "hello brave world", {
      ok: true,
      content: "hello old world",
    });

    const rendered = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      tokenTheme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "unified" }
    ).text;

    expect(rendered).toContain("old");
    expect(rendered).toContain("brave");
    expect(rendered).toContain("\x1b[48;2;");
    expect(rendered).not.toContain("<accent>");
  });

  test("restores diff row highlights to the tool block background", () => {
    const details = createWriteDiffDetails("file.txt", "hello brave world", {
      ok: true,
      content: "hello old world",
    });

    const rendered = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      ansiDiffTheme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "unified" }
    )
      .render(80)
      .join("\n");

    const changedLines = rendered
      .split("\n")
      .filter((line) => line.includes("world"));
    expect(changedLines).toHaveLength(2);
    for (const line of changedLines) {
      expect(line).toContain(toolSuccessBgAnsi);
      const suffix = line.split("world\x1b[39m")[1] ?? "";
      expect(suffix.startsWith(" ")).toBe(true);
      expect(suffix).toContain(toolSuccessBgAnsi);
    }
  });

  test("parses changed content that looks like diff headers", () => {
    const rendered = renderFinalDiffResult(
      {
        content: [],
        details: {
          diff: [
            "--- file.txt",
            "+++ file.txt",
            "@@ -1,2 +1,2 @@",
            "--- old content marker",
            "+++ new content marker",
          ].join("\n"),
        },
      },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "unified" }
    )
      .render(120)
      .join("\n");

    expect(rendered).toContain("▌-- old content marker");
    expect(rendered).toContain("▌++ new content marker");
    expect(rendered).not.toContain(
      "--- old content marker\n+++ new content marker"
    );
  });

  test("skips inline word highlights for very long changed lines", () => {
    const oldText = `${"a".repeat(701)} old`;
    const newText = `${"a".repeat(701)} new`;
    const details = createWriteDiffDetails("file.txt", newText, {
      ok: true,
      content: oldText,
    });

    const rendered = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      tokenTheme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "unified" }
    )
      .render(2000)
      .join("\n");

    expect(rendered).toContain(`▌${oldText}`);
    expect(rendered).toContain(`▌${newText}`);
    expect(rendered).not.toContain("<accent>");
  });

  test("skips inline word highlights when token matrix is too large", () => {
    const oldText = "a.".repeat(201);
    const newText = "b,".repeat(201);
    const details = createWriteDiffDetails("file.txt", newText, {
      ok: true,
      content: oldText,
    });

    const rendered = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      tokenTheme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "unified" }
    )
      .render(2000)
      .join("\n");

    expect(rendered).toContain(`▌${oldText}`);
    expect(rendered).toContain(`▌${newText}`);
    expect(rendered.split("\x1b[48;2;").length).toBeLessThan(10);
  });

  test("counts rendered split rows when collapsed", () => {
    const details = createWriteDiffDetails("file.txt", "new1\nnew2\nnew3\n", {
      ok: true,
      content: "old1\nold2\nold3\n",
    });
    const rendered = renderFinalDiffResult(
      { content: [], details },
      { expanded: true },
      theme,
      {
        collapsed: true,
        enabled: true,
        previewLines: 3,
        viewMode: "split",
        wordWrap: false,
      }
    )
      .render(140)
      .join("\n");

    expect(rendered).toContain("▌1 │ old1");
    expect(rendered).toContain("▌2 │ old2");
    expect(rendered).not.toContain("▌3 │ old3");
    expect(rendered).toContain("… 2 diff lines collapsed");
  });

  test("shares final diff rendering for edit and write results", () => {
    const diff = "--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-old\n+new";
    const editRendered = renderFinalDiffResult(
      { content: [], details: { diff } },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "split" }
    ).render(140);
    const writeRendered = renderFinalDiffResult(
      {
        content: [],
        details: {
          toolDisplay: { writeDiff: diff, writeSummary: "rewrote file" },
        },
      },
      { expanded: true },
      theme,
      { collapsed: false, enabled: true, previewLines: 20, viewMode: "split" }
    ).render(140);

    expect(renderEditCall({ path: "a.txt" }, theme).text).toBe("edit a.txt");
    expect(renderWriteCall({ content: "new", path: "a.txt" }, theme).text).toBe(
      "write a.txt (1 lines)"
    );
    expect(editRendered.slice(1)).toEqual(writeRendered.slice(1));
  });
});
