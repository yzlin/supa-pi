import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatDocsList, listDocs, resolveDocsRoot } from "./core";
import docsListExtension from "./index";

type ToolRegistration = Parameters<ExtensionAPI["registerTool"]>[0];

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "docs-list-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createExtensionHarness() {
  const tools: ToolRegistration[] = [];

  docsListExtension({
    registerTool(tool: ToolRegistration) {
      tools.push(tool);
    },
  } as ExtensionAPI);

  if (!tools[0]) {
    throw new Error("docs_list tool was not registered");
  }

  return { tool: tools[0], tools };
}

describe("docs-list core", () => {
  test("defaults to docs and extracts summary/read_when only", () => {
    const cwd = makeTempDir();
    const docsDir = join(cwd, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(
      join(docsDir, "guide.md"),
      "---\nsummary: Test guide\nread_when:\n  - testing docs\nother: ignored\n---\n# Guide\n"
    );
    writeFileSync(
      join(docsDir, "bad.md"),
      "---\nread_when: ['bad front matter']\n---\n# Bad\n"
    );
    writeFileSync(
      join(docsDir, "archive.md"),
      "---\nsummary: Archive file at root is allowed\n---\n"
    );

    const result = listDocs({ cwd });

    expect(result).toMatchObject({
      ok: true,
      target: "docs",
      root: docsDir,
      rootPath: docsDir,
      exists: true,
      warningCount: 1,
    });
    expect(result.entries).toBe(result.docs);
    expect(result.warnings).toEqual([
      { path: "bad.md", message: "summary key missing" },
    ]);
    expect(result.docs.map((doc) => doc.path)).toEqual([
      "archive.md",
      "bad.md",
      "guide.md",
    ]);
    expect(result.docs.find((doc) => doc.path === "guide.md")).toMatchObject({
      summary: "Test guide",
      readWhen: ["testing docs"],
      warnings: [],
    });
    expect(result.docs.find((doc) => doc.path === "bad.md")).toMatchObject({
      summary: null,
      readWhen: ["bad front matter"],
      warnings: ["summary key missing"],
    });
  });

  test("uses optional relative path", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, "knowledge"), { recursive: true });
    writeFileSync(
      join(cwd, "knowledge", "note.md"),
      "---\nsummary: Knowledge note\n---\n"
    );

    const result = listDocs({ cwd, path: "@knowledge" });

    expect(result).toMatchObject({
      target: "knowledge",
      root: join(cwd, "knowledge"),
      rootPath: join(cwd, "knowledge"),
      exists: true,
    });
    expect(result.docs.map((doc) => doc.path)).toEqual(["note.md"]);
  });

  test("warns for missing and invalid front matter without failing", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "missing.md"), "# Missing\n");
    writeFileSync(
      join(cwd, "docs", "invalid.md"),
      "---\nsummary: Broken\nread_when: [bad]\n---\n"
    );
    writeFileSync(
      join(cwd, "docs", "unterminated.md"),
      "---\nsummary: Never closed\n"
    );

    const result = listDocs({ cwd });

    expect(result.ok).toBe(true);
    expect(result.warningCount).toBe(3);
    expect(result.warnings).toEqual([
      { path: "invalid.md", message: "malformed read_when inline array" },
      { path: "missing.md", message: "missing front matter" },
      { path: "unterminated.md", message: "unterminated front matter" },
    ]);
    expect(result.docs.find((doc) => doc.path === "invalid.md")).toMatchObject({
      summary: "Broken",
      readWhen: [],
      warnings: ["malformed read_when inline array"],
    });
  });

  test("excludes archive and research directories", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, "docs", "archive"), { recursive: true });
    mkdirSync(join(cwd, "docs", "research"), { recursive: true });
    writeFileSync(join(cwd, "docs", "keep.md"), "---\nsummary: Keep\n---\n");
    writeFileSync(
      join(cwd, "docs", "archive", "old.md"),
      "---\nsummary: Old\n---\n"
    );
    writeFileSync(
      join(cwd, "docs", "research", "draft.md"),
      "---\nsummary: Draft\n---\n"
    );

    const result = listDocs({ cwd });

    expect(result.docs.map((doc) => doc.path)).toEqual(["keep.md"]);
  });

  test("strips leading at and rejects unsafe paths", () => {
    const cwd = makeTempDir();

    expect(resolveDocsRoot(cwd, "@docs")).toBe(join(cwd, "docs"));
    expect(() => resolveDocsRoot(cwd, "/tmp/docs")).toThrow(
      "path must be relative"
    );
    expect(() => resolveDocsRoot(cwd, "../docs")).toThrow(
      "path must not escape cwd"
    );
  });

  test("rejects symlinked docs root outside cwd", () => {
    const cwd = makeTempDir();
    const outside = makeTempDir();
    symlinkSync(outside, join(cwd, "docs"), "dir");

    expect(() => listDocs({ cwd })).toThrow("path must stay within cwd");
  });

  test("formats readable output", () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(
      join(cwd, "docs", "guide.md"),
      "---\nsummary: Guide\nread_when:\n  - when testing docs\n---\n"
    );
    writeFileSync(join(cwd, "docs", "plain.md"), "# Plain\n");

    const output = formatDocsList(listDocs({ cwd }));

    expect(output).toContain("Listing all markdown files in docs folder:");
    expect(output).toContain("guide.md - Guide");
    expect(output).toContain("  Read when: when testing docs");
    expect(output).toContain("plain.md - [missing front matter]");
    expect(output).toContain("Reminder: keep docs up to date");
  });
});

describe("docs-list extension", () => {
  test("registers docs_list tool", () => {
    const { tool, tools } = createExtensionHarness();

    expect(tools).toHaveLength(1);
    expect(tool.name).toBe("docs_list");
    expect(tool.label).toBe("Docs List");
    expect(tool.promptSnippet).toBe(
      "Discover project markdown docs with summary and read_when metadata before coding"
    );
    expect(tool.promptGuidelines).toEqual([
      "Use docs_list when the user asks for docs discovery or relevant project guidance says to discover docs before coding.",
      "Keep usage narrow: do not call docs_list for unrelated code search or implementation work.",
    ]);
  });

  test("returns rendered content and structured details", async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(
      join(cwd, "docs", "guide.md"),
      "---\nsummary: Extension guide\n---\n"
    );
    const { tool } = createExtensionHarness();

    const result = await tool.execute("tool-call", {}, undefined, undefined, {
      cwd,
    } as never);

    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("guide.md - Extension guide"),
      },
    ]);
    expect(result.details).toMatchObject({
      ok: true,
      target: "docs",
      exists: true,
      warningCount: 0,
      docs: [{ path: "guide.md", summary: "Extension guide" }],
    });
  });

  test("returns soft warnings in content and details", async () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "plain.md"), "# Plain\n");
    const { tool } = createExtensionHarness();

    const result = await tool.execute("tool-call", {}, undefined, undefined, {
      cwd,
    } as never);

    const firstContent = result.content[0];
    if (firstContent?.type !== "text") {
      throw new Error("Expected text content");
    }
    expect(firstContent.text).toContain("plain.md - [missing front matter]");
    expect(result.details).toMatchObject({
      ok: true,
      exists: true,
      warningCount: 1,
      warnings: [{ path: "plain.md", message: "missing front matter" }],
    });
  });

  test("returns structured error details for unsafe paths", async () => {
    const cwd = makeTempDir();
    const { tool } = createExtensionHarness();

    const result = await tool.execute(
      "tool-call",
      { path: "../docs" },
      undefined,
      undefined,
      { cwd } as never
    );

    expect(result.content).toEqual([
      { type: "text", text: "Error: path must not escape cwd" },
    ]);
    expect(result.details).toEqual({
      ok: false,
      error: true,
      message: "path must not escape cwd",
      warnings: [{ message: "path must not escape cwd" }],
      warningCount: 1,
    });
    expect(result).toMatchObject({ isError: true });
  });
});
