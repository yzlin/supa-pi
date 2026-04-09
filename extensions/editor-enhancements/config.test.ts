import { describe, expect, it } from "bun:test";

import { resolveRuntimeConfig } from "./config";
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
          skipHidden: true,
          allowFolderSelection: false,
          skipPatterns: ["global"],
          tabCompletionMode: "segment",
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
      },
      {
        respectGitignore: false,
        allowFolderSelection: true,
        skipPatterns: ["legacy"],
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
      },
    });
  });

  it("falls back to legacy file picker config when newer configs omit it", () => {
    const config = resolveRuntimeConfig(
      {
        doubleEscapeCommand: "global-command",
      },
      {
        commandRemap: {
          tree: "anycopy",
        },
      },
      {
        skipHidden: false,
        allowFolderSelection: false,
        skipPatterns: ["legacy-only"],
        tabCompletionMode: "segment",
      }
    );

    expect(config).toEqual({
      doubleEscapeCommand: "global-command",
      commandRemap: {
        tree: "anycopy",
      },
      filePicker: {
        ...DEFAULT_FILE_PICKER_CONFIG,
        skipHidden: false,
        allowFolderSelection: false,
        skipPatterns: ["legacy-only"],
        tabCompletionMode: "segment",
      },
    });
  });
});
