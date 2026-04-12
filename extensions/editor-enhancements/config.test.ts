import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";

import { loadConfig, resolveRuntimeConfig } from "./config";
import { DEFAULT_FILE_PICKER_CONFIG } from "./file-picker-config";

describe("editor enhancements config", () => {
  it("merges command and nested file picker config with project precedence", () => {
    const config = resolveRuntimeConfig(
      {
        doubleEscapeCommand: "global-command",
        commandRemap: {
          tree: "global-tree",
          test: "global-test",
        },
        filePicker: {
          respectGitignore: false,
          skipHidden: true,
          allowFolderSelection: false,
          skipPatterns: ["global"],
          tabCompletionMode: "segment",
          previewHighlightMode: "builtin",
        },
        statusBar: {
          enabled: false,
          preset: "minimal",
          leftSegments: ["path"],
          rightSegments: ["context_pct"],
          separator: " / ",
          colors: {
            path: "warning",
            separator: "dim",
          },
          segmentOptions: {
            path: { mode: "abbreviated", maxLength: 20 },
            git: { showUntracked: true },
          },
        },
      },
      {
        doubleEscapeCommand: "project-command",
        commandRemap: {
          tree: "project-tree",
        },
        filePicker: {
          skipHidden: false,
          skipPatterns: ["project"],
        },
        statusBar: {
          preset: "compact",
          leftSegments: ["model", "git"],
          rightSegments: [],
          separator: " | ",
          colors: {
            model: "success",
            context: "#89d281",
          },
          segmentOptions: {
            path: { maxLength: 12 },
            model: { showThinkingLevel: true },
          },
        },
      }
    );

    expect(config).toEqual({
      doubleEscapeCommand: "project-command",
      commandRemap: {
        tree: "project-tree",
        test: "global-test",
      },
      filePicker: {
        ...DEFAULT_FILE_PICKER_CONFIG,
        respectGitignore: false,
        skipHidden: false,
        allowFolderSelection: false,
        skipPatterns: ["project"],
        tabCompletionMode: "segment",
        previewHighlightMode: "builtin",
      },
      statusBar: {
        enabled: false,
        preset: "compact",
        leftSegments: ["model", "git"],
        rightSegments: [],
        separator: " | ",
        colors: {
          path: "warning",
          separator: "dim",
          model: "success",
          context: "#89d281",
        },
        segmentOptions: {
          path: { mode: "abbreviated", maxLength: 12 },
          git: { showUntracked: true },
          model: { showThinkingLevel: true },
        },
      },
    });
  });

  it("uses defaults when file picker config is omitted", () => {
    const config = resolveRuntimeConfig(
      {
        doubleEscapeCommand: "global-command",
      },
      {
        commandRemap: {
          tree: "anycopy",
        },
      }
    );

    expect(config).toEqual({
      doubleEscapeCommand: "global-command",
      commandRemap: {
        tree: "anycopy",
      },
      filePicker: DEFAULT_FILE_PICKER_CONFIG,
      statusBar: {
        enabled: true,
        preset: "default",
      },
    });
  });

  it("falls back to global status bar segments when project does not override them", () => {
    const config = resolveRuntimeConfig(
      {
        statusBar: {
          preset: "minimal",
          leftSegments: ["path"],
          rightSegments: ["context_pct"],
        },
      },
      {
        statusBar: {
          preset: "compact",
        },
      }
    );

    expect(config.statusBar).toEqual({
      enabled: true,
      preset: "compact",
      leftSegments: ["path"],
      rightSegments: ["context_pct"],
    });
  });

  it("merges status bar colors by semantic key", () => {
    const config = resolveRuntimeConfig(
      {
        statusBar: {
          colors: {
            model: "warning",
            separator: "dim",
          },
        },
      },
      {
        statusBar: {
          colors: {
            model: "success",
            context: "#89d281",
          },
        },
      }
    );

    expect(config.statusBar.colors).toEqual({
      model: "success",
      separator: "dim",
      context: "#89d281",
    });
  });

  it("merges status bar segment options by nested field", () => {
    const config = resolveRuntimeConfig(
      {
        statusBar: {
          segmentOptions: {
            path: { mode: "abbreviated", maxLength: 24 },
            git: { showUntracked: true, showStaged: false },
          },
        },
      },
      {
        statusBar: {
          segmentOptions: {
            path: { maxLength: 12 },
            git: { showBranch: false },
            time: { format: "12h" },
          },
        },
      }
    );

    expect(config.statusBar.segmentOptions).toEqual({
      path: { mode: "abbreviated", maxLength: 12 },
      git: { showUntracked: true, showStaged: false, showBranch: false },
      time: { format: "12h" },
    });
  });

  it("preserves an empty literal separator from file config", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "editor-enhancements-"));
    const homeDir = path.join(tempRoot, "home");
    const cwd = path.join(tempRoot, "project");

    fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "editor-enhancements.json"),
      JSON.stringify({
        statusBar: {
          separator: "",
        },
      })
    );

    try {
      const config = loadConfig({ homeDir, cwd });
      expect(config.statusBar.separator).toBe("");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
