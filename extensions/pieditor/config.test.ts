import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  hasProjectFixedEditorEnabledOverride,
  loadConfig,
  resolveRuntimeConfig,
  saveGlobalFixedEditorEnabled,
} from "./config";
import { DEFAULT_FIXED_EDITOR_CONFIG } from "./config/fixed-editor";
import { DEFAULT_FILE_PICKER_CONFIG } from "./file-picker-config";

describe("pieditor config", () => {
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
        fixedEditor: {
          enabled: true,
          mouseScroll: true,
          scrollUpShortcuts: ["super+up"],
          scrollDownShortcuts: ["super+down"],
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
        fixedEditor: {
          mouseScroll: false,
          scrollUpShortcuts: "ctrl+shift+up",
          scrollDownShortcuts: ["ctrl+shift+down", "super+down"],
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
      fixedEditor: {
        enabled: true,
        mouseScroll: false,
        scrollUpShortcuts: ["ctrl+shift+up"],
        scrollDownShortcuts: ["ctrl+shift+down", "super+down"],
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
      fixedEditor: DEFAULT_FIXED_EDITOR_CONFIG,
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

  it("loads fixed editor defaults and normalized project overrides", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pieditor-"));
    const homeDir = join(tempRoot, "home");
    const cwd = join(tempRoot, "project");

    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pieditor.json"),
      JSON.stringify({
        fixedEditor: {
          enabled: true,
          mouseScroll: false,
          scrollUpShortcuts: [" ctrl+shift+up ", ""],
          scrollDownShortcuts: "super+down",
        },
      })
    );

    try {
      const config = loadConfig({ homeDir, cwd });
      expect(config.fixedEditor).toEqual({
        enabled: true,
        mouseScroll: false,
        scrollUpShortcuts: ["ctrl+shift+up"],
        scrollDownShortcuts: ["super+down"],
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("saves global fixed editor enabled without overwriting other config", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pieditor-"));
    const homeDir = join(tempRoot, "home");
    const cwd = join(tempRoot, "project");
    const globalConfigPath = join(homeDir, ".pi", "agent", "pieditor.json");

    mkdirSync(dirname(globalConfigPath), { recursive: true });
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        commandRemap: { tree: "anycopy" },
        fixedEditor: { mouseScroll: false },
      })
    );

    try {
      const result = saveGlobalFixedEditorEnabled(true, { homeDir, cwd });
      const saved = JSON.parse(readFileSync(globalConfigPath, "utf-8"));

      expect(result.ok).toBe(true);
      expect(saved).toEqual({
        commandRemap: { tree: "anycopy" },
        fixedEditor: { mouseScroll: false, enabled: true },
      });
      expect(
        readdirSync(dirname(globalConfigPath)).filter((entry) =>
          entry.endsWith(".tmp")
        )
      ).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns project-layered config after saving global fixed editor state", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pieditor-"));
    const homeDir = join(tempRoot, "home");
    const cwd = join(tempRoot, "project");
    const projectConfigPath = join(cwd, ".pi", "pieditor.json");

    mkdirSync(dirname(projectConfigPath), { recursive: true });
    writeFileSync(
      projectConfigPath,
      JSON.stringify({ fixedEditor: { enabled: false, mouseScroll: false } })
    );

    try {
      const result = saveGlobalFixedEditorEnabled(true, { homeDir, cwd });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.config.fixedEditor).toEqual({
        ...DEFAULT_FIXED_EDITOR_CONFIG,
        enabled: false,
        mouseScroll: false,
      });
      expect(hasProjectFixedEditorEnabledOverride({ cwd })).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses to save fixed editor state over invalid global JSON", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pieditor-"));
    const homeDir = join(tempRoot, "home");
    const cwd = join(tempRoot, "project");
    const globalConfigPath = join(homeDir, ".pi", "agent", "pieditor.json");

    mkdirSync(dirname(globalConfigPath), { recursive: true });
    writeFileSync(globalConfigPath, "{not-json", "utf-8");

    try {
      const result = saveGlobalFixedEditorEnabled(true, { homeDir, cwd });
      expect(result.ok).toBe(false);
      expect(readFileSync(globalConfigPath, "utf-8")).toBe("{not-json");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("detects project fixed editor enabled overrides", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pieditor-"));
    const cwd = join(tempRoot, "project");

    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pieditor.json"),
      JSON.stringify({ fixedEditor: { enabled: false } })
    );

    try {
      expect(hasProjectFixedEditorEnabledOverride({ cwd })).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves an empty literal separator from file config", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "pieditor-"));
    const homeDir = join(tempRoot, "home");
    const cwd = join(tempRoot, "project");

    mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pieditor.json"),
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
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
