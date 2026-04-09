import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPreviewData } from "./file-picker-preview";
import type { FileEntry } from "./file-picker-types";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-file-picker-preview-"));
  tempDirs.push(dir);
  return dir;
}

function entry(relativePath: string, isDirectory: boolean): FileEntry {
  return {
    name: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    isDirectory,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("file picker preview", () => {
  it("renders numbered text previews and truncates to the requested line count", () => {
    const root = createTempDir();
    writeFileSync(join(root, "notes.txt"), "alpha\nbeta\ncharlie\n", "utf8");

    const preview = loadPreviewData({
      cwdRoot: root,
      currentDir: root,
      entry: entry("notes.txt", false),
      maxLines: 2,
      maxBytes: 4096,
    });

    expect(preview).toEqual({
      kind: "file",
      title: "notes.txt",
      details: "text • 19 B",
      lines: [" 1 │ alpha", "… preview truncated"],
    });
  });

  it("normalizes tabs in text previews to avoid width drift", () => {
    const root = createTempDir();
    writeFileSync(
      join(root, "tabs.ts"),
      "\tif (ready) {\n\t\treturn ok;\n",
      "utf8"
    );

    const preview = loadPreviewData({
      cwdRoot: root,
      currentDir: root,
      entry: entry("tabs.ts", false),
      maxLines: 4,
      maxBytes: 4096,
    });

    expect(preview.lines).toEqual([
      " 1 │   if (ready) {",
      " 2 │     return ok;",
      " 3 │ ",
    ]);
  });

  it("lists directory previews with directories first", () => {
    const root = createTempDir();
    mkdirSync(join(root, "docs", "guides"), { recursive: true });
    writeFileSync(join(root, "docs", "z-last.md"), "z", "utf8");
    writeFileSync(join(root, "docs", "a-first.md"), "a", "utf8");

    const preview = loadPreviewData({
      cwdRoot: root,
      currentDir: root,
      entry: entry("docs", true),
      maxLines: 5,
    });

    expect(preview).toEqual({
      kind: "directory",
      title: "docs/",
      details: "directory • 3 items",
      lines: ["guides/", "a-first.md", "z-last.md"],
    });
  });

  it("describes navigation previews for the parent entry", () => {
    const root = createTempDir();
    mkdirSync(join(root, "src"), { recursive: true });

    const preview = loadPreviewData({
      cwdRoot: root,
      currentDir: join(root, "src"),
      entry: { name: "..", relativePath: "..", isDirectory: true },
    });

    expect(preview).toEqual({
      kind: "navigation",
      title: "..",
      details: "navigate • .",
      lines: ["Move up one level.", "Current: src"],
    });
  });

  it("marks binary previews as unavailable", () => {
    const root = createTempDir();
    writeFileSync(join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));

    const preview = loadPreviewData({
      cwdRoot: root,
      currentDir: root,
      entry: entry("image.bin", false),
    });

    expect(preview).toEqual({
      kind: "binary",
      title: "image.bin",
      details: "binary • 4 B",
      lines: [
        "Binary file preview unavailable.",
        "Attach to inspect with tools.",
      ],
    });
  });

  it("refuses previews outside the picker root", () => {
    const baseDir = createTempDir();
    const root = join(baseDir, "workspace");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(baseDir, "outside.txt"), "secret", "utf8");

    const preview = loadPreviewData({
      cwdRoot: root,
      currentDir: root,
      entry: entry("../outside.txt", false),
    });

    expect(preview).toEqual({
      kind: "file",
      title: "../outside.txt",
      details: "file",
      lines: ["File preview unavailable."],
    });
  });
});
