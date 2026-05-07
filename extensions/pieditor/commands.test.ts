import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerPieditorCommands } from "./commands";
import { DEFAULT_FIXED_EDITOR_CONFIG } from "./config/fixed-editor";

type RegisteredCommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type HarnessCommandOptions = RegisteredCommandOptions & {
  handler: NonNullable<RegisteredCommandOptions["handler"]>;
};

const originalHome = process.env.HOME;
const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pieditor-command-"));
  tempRoots.push(dir);
  return dir;
}

function createHarness(homeDir?: string) {
  let command: HarnessCommandOptions | null = null;
  let fixedEditorConfig = { ...DEFAULT_FIXED_EDITOR_CONFIG };

  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    registerCommand(_name: string, options: RegisteredCommandOptions) {
      command = options as HarnessCommandOptions;
    },
  } as ExtensionAPI;

  registerPieditorCommands(
    pi,
    {
      getFixedEditorConfig() {
        return fixedEditorConfig;
      },
      setFixedEditorEnabled(enabled: boolean) {
        fixedEditorConfig = { ...fixedEditorConfig, enabled };
      },
    },
    { homeDir }
  );

  if (!command) {
    throw new Error("pieditor command was not registered");
  }

  return {
    command,
    notifications,
    getFixedEditorConfig: () => fixedEditorConfig,
    createContext(cwd: string) {
      return {
        cwd,
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      };
    },
  };
}

afterEach(() => {
  process.env.HOME = originalHome;
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("pieditor command", () => {
  it("enables fixed editor mode live and saves global config", async () => {
    const root = createTempDir();
    const homeDir = join(root, "home");
    const cwd = join(root, "project");

    const harness = createHarness(homeDir);
    await harness.command.handler(
      "fixed-editor on",
      harness.createContext(cwd) as never
    );

    const saved = JSON.parse(
      readFileSync(join(homeDir, ".pi", "agent", "pieditor.json"), "utf-8")
    );

    expect(harness.getFixedEditorConfig().enabled).toBe(true);
    expect(saved.fixedEditor.enabled).toBe(true);
    expect(harness.notifications).toContainEqual({
      message: "pieditor fixed-editor enabled (saved)",
      level: "info",
    });
  });

  it("warns when a project fixed editor enabled override is active", async () => {
    const root = createTempDir();
    const homeDir = join(root, "home");
    const cwd = join(root, "project");

    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pieditor.json"),
      JSON.stringify({ fixedEditor: { enabled: false } }),
      "utf-8"
    );

    const harness = createHarness(homeDir);
    await harness.command.handler(
      "fixed-editor on",
      harness.createContext(cwd) as never
    );

    expect(harness.getFixedEditorConfig().enabled).toBe(true);
    expect(harness.notifications).toContainEqual({
      message:
        "Project .pi/pieditor.json overrides fixedEditor.enabled; global save will not affect next load in this project.",
      level: "warning",
    });
  });

  it("applies live state without overwriting invalid global JSON", async () => {
    const root = createTempDir();
    const homeDir = join(root, "home");
    const cwd = join(root, "project");
    const globalConfigPath = join(homeDir, ".pi", "agent", "pieditor.json");

    mkdirSync(dirname(globalConfigPath), { recursive: true });
    writeFileSync(globalConfigPath, "{not-json", "utf-8");

    const harness = createHarness(homeDir);
    await harness.command.handler(
      "fixed-editor on",
      harness.createContext(cwd) as never
    );

    expect(harness.getFixedEditorConfig().enabled).toBe(true);
    expect(readFileSync(globalConfigPath, "utf-8")).toBe("{not-json");
    expect(harness.notifications[0]?.level).toBe("error");
    expect(harness.notifications[0]?.message).toContain("live only; not saved");
  });

  it("reports fixed editor status without persisting", async () => {
    const root = createTempDir();
    const homeDir = join(root, "home");
    const cwd = join(root, "project");

    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pieditor.json"),
      JSON.stringify({ fixedEditor: { enabled: true } }),
      "utf-8"
    );

    const harness = createHarness(homeDir);
    await harness.command.handler(
      "fixed-editor status",
      harness.createContext(cwd) as never
    );

    expect(harness.notifications).toEqual([
      {
        message: "pieditor fixed-editor disabled (project override active)",
        level: "info",
      },
    ]);
  });

  it("toggles and disables fixed editor mode", async () => {
    const root = createTempDir();
    const homeDir = join(root, "home");
    const cwd = join(root, "project");

    const harness = createHarness(homeDir);
    await harness.command.handler(
      "fixed-editor toggle",
      harness.createContext(cwd) as never
    );
    expect(harness.getFixedEditorConfig().enabled).toBe(true);

    await harness.command.handler(
      "fixed-editor off",
      harness.createContext(cwd) as never
    );
    expect(harness.getFixedEditorConfig().enabled).toBe(false);
  });

  it("warns for unknown pieditor command topics and completes fixed editor actions", async () => {
    const root = createTempDir();
    const harness = createHarness(join(root, "home"));

    await harness.command.handler(
      "unknown",
      harness.createContext(join(root, "project")) as never
    );

    expect(harness.notifications).toEqual([
      {
        message: "Usage: /pieditor fixed-editor [on|off|toggle|status]",
        level: "warning",
      },
    ]);
    expect(harness.command.getArgumentCompletions?.("fixed-editor t")).toEqual([
      {
        value: "fixed-editor toggle",
        label: "fixed-editor toggle",
        description: "Toggle fixed editor mode",
      },
    ]);
  });
});
