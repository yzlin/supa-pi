import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { registerToolDisplayCommands } from "./commands";
import {
  DEFAULT_TOOL_DISPLAY_CONFIG,
  getProjectToolDisplayConfigPath,
} from "./config";

type RegisteredCommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type HarnessCommandOptions = RegisteredCommandOptions & {
  getArgumentCompletions: NonNullable<
    RegisteredCommandOptions["getArgumentCompletions"]
  >;
  handler: NonNullable<RegisteredCommandOptions["handler"]>;
};

function registerHarness(): HarnessCommandOptions {
  let commandOptions: RegisteredCommandOptions | undefined;

  registerToolDisplayCommands({
    registerCommand(_name: string, options: RegisteredCommandOptions) {
      commandOptions = options;
    },
  } as ExtensionAPI);

  if (!commandOptions) {
    throw new Error("tool-display command was not registered");
  }

  return commandOptions as HarnessCommandOptions;
}

function createContext(cwd: string, notify: (message: string) => void) {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify(message: string) {
        notify(message);
      },
    },
  } as unknown as ExtensionCommandContext;
}

describe("tool-display commands", () => {
  it("registers completions", () => {
    const command = registerHarness();

    expect(command.getArgumentCompletions("")).toEqual([
      {
        value: "show",
        label: "show",
        description: "Show resolved tool-display config",
      },
      {
        value: "preset",
        label: "preset",
        description: "Write a preset project config",
      },
      {
        value: "reset",
        label: "reset",
        description: "Write default project config",
      },
      { value: "help", label: "help", description: "Show help" },
    ]);
    expect(command.getArgumentCompletions("preset v")).toEqual([
      {
        value: "preset verbose",
        label: "verbose",
        description: "Enable expanded output previews",
      },
    ]);
  });

  it("shows resolved defaults", async () => {
    const command = registerHarness();
    const cwd = mkdtempSync(join(tmpdir(), "tool-display-command-"));
    const messages: string[] = [];

    try {
      await command.handler(
        "show",
        createContext(cwd, (message) => {
          messages.push(message);
        })
      );

      expect(messages[0]).toContain("tool-display");
      expect(messages[0]).toContain("tools.search.enabled: on");
      expect(messages[0]).toContain("output.bash: compact");
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("writes default project config on reset", async () => {
    const command = registerHarness();
    const cwd = mkdtempSync(join(tmpdir(), "tool-display-command-"));

    try {
      const messages: string[] = [];
      await command.handler(
        "reset",
        createContext(cwd, (message) => {
          messages.push(message);
        })
      );
      const configPath = getProjectToolDisplayConfigPath(cwd);

      expect(existsSync(configPath)).toBe(true);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(
        DEFAULT_TOOL_DISPLAY_CONFIG
      );
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("writes presets to project config", async () => {
    const command = registerHarness();
    const cwd = mkdtempSync(join(tmpdir(), "tool-display-command-"));

    try {
      const messages: string[] = [];
      await command.handler(
        "preset off",
        createContext(cwd, (message) => {
          messages.push(message);
        })
      );
      const config = JSON.parse(
        readFileSync(getProjectToolDisplayConfigPath(cwd), "utf8")
      );

      expect(config.tools.read.enabled).toBe(false);
      expect(config.tools.search.enabled).toBe(false);
      expect(config.output.bash.rtkHints).toBe(true);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});
