import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initTheme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

import {
  FileBrowserComponent,
  highlightPreviewLine,
  truncateVisibleText,
} from "./file-picker";

initTheme("dark");

const previewPath = "example.ts";
const tempDirs: string[] = [];
const originalCwd = process.cwd();

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-file-picker-render-"));
  tempDirs.push(dir);
  return dir;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("file picker preview rendering", () => {
  it("syntax highlights only the code portion of numbered preview lines", () => {
    const line = highlightPreviewLine(" 1 │ const answer = 42;", previewPath);

    expect(line.startsWith(" 1 │ ")).toBe(true);
    expect(line).toContain("\x1b[");
    expect(line.indexOf("\x1b[")).toBeGreaterThanOrEqual(" 1 │ ".length);
  });

  it("leaves non-code preview rows unchanged", () => {
    expect(highlightPreviewLine("… preview truncated", previewPath)).toBe(
      "… preview truncated"
    );
  });

  it("truncates highlighted preview lines with ANSI-safe width handling", () => {
    const highlighted = highlightPreviewLine(
      " 1 │ const extraordinarilyLongIdentifier = 42;",
      previewPath
    );

    const truncated = truncateVisibleText(highlighted, 16);

    expect(visibleWidth(truncated)).toBe(16);
    expect(truncated).toContain("…");
    expect(truncated).toContain("\x1b[");
  });
});

describe("file picker folder rendering", () => {
  it("shows navigation markers instead of unchecked boxes for folders when folder selection is disabled", () => {
    const root = createTempDir();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "alpha.txt"), "alpha", "utf8");
    process.chdir(root);

    const browser = new FileBrowserComponent(() => {});
    browser.handleInput("\u001b[Z");
    browser.handleInput("\u001b[B");
    browser.handleInput(" ");
    browser.handleInput("\u001b");

    const rendered = stripAnsi(browser.render(120).join("\n"));

    expect(rendered).toContain("› docs/");
    expect(rendered).not.toContain("☐ docs/");
    expect(rendered).toContain("No files selected");
    expect(rendered).toContain("space queue file");
  });
});
