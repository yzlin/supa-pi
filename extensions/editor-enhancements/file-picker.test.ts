import { describe, expect, it } from "bun:test";

import {
  getLanguageFromPath,
  initTheme,
} from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

import {
  highlightPreviewLine,
  truncateVisibleText,
} from "./file-picker";

initTheme("dark");

const previewLanguage = getLanguageFromPath("example.ts");

describe("file picker preview rendering", () => {
  it("syntax highlights only the code portion of numbered preview lines", () => {
    const line = highlightPreviewLine(" 1 │ const answer = 42;", previewLanguage);

    expect(line.startsWith(" 1 │ ")).toBe(true);
    expect(line).toContain("\x1b[");
    expect(line.indexOf("\x1b[")).toBeGreaterThanOrEqual(" 1 │ ".length);
  });

  it("leaves non-code preview rows unchanged", () => {
    expect(highlightPreviewLine("… preview truncated", previewLanguage)).toBe(
      "… preview truncated"
    );
  });

  it("truncates highlighted preview lines with ANSI-safe width handling", () => {
    const highlighted = highlightPreviewLine(
      " 1 │ const extraordinarilyLongIdentifier = 42;",
      previewLanguage
    );

    const truncated = truncateVisibleText(highlighted, 16);

    expect(visibleWidth(truncated)).toBe(16);
    expect(truncated).toContain("…");
    expect(truncated).toContain("\x1b[");
  });
});
