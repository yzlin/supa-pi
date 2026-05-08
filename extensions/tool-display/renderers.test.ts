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
  renderFinalDiffResult,
} from "./renderers";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
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
    ).toContain("+new");
  });

  test("renders expanded diff modes and collapse limits", () => {
    const details = createWriteDiffDetails("file.txt", "new\nmore\n", {
      ok: true,
      content: "old\nless\n",
    });

    const originalColumns = process.stdout.columns;
    process.stdout.columns = 80;
    expect(
      renderFinalDiffResult(
        { content: [], details },
        { expanded: true },
        theme,
        { collapsed: true, enabled: true, previewLines: 3 }
      ).text
    ).toContain("… 3 diff lines collapsed");

    process.stdout.columns = 120;
    expect(
      renderFinalDiffResult(
        { content: [], details },
        { expanded: true },
        theme,
        { collapsed: true, enabled: true, previewLines: 20 }
      ).text
    ).toContain(" │ ");
    process.stdout.columns = originalColumns;
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
});
