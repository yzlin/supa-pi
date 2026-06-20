import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir as osHomedir, tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const realHomeDir = osHomedir();
let currentHomeDir = realHomeDir;
mock.module("node:os", () => ({
  default: {
    homedir: () => currentHomeDir,
    tmpdir: osTmpdir,
  },
  homedir: () => currentHomeDir,
  tmpdir: osTmpdir,
}));

const {
  default: whimsicalExtension,
  readCustomMessageSetFile,
  validateMessageSet,
} = await import("./index");

type RegisteredCommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type ExtensionEventHandler = (...args: unknown[]) => unknown;
type HarnessCommandOptions = RegisteredCommandOptions & {
  handler: NonNullable<RegisteredCommandOptions["handler"]>;
};

interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

interface NotificationUpdate {
  message: string;
  type: string | undefined;
}

let testRootDir = "";
let testHomeDir = "";
const originalRandom = Math.random;

beforeEach(() => {
  testRootDir = mkdtempSync(join("/tmp", "supa-pi-whimsical-"));
  testHomeDir = join(testRootDir, "home");
  mkdirSync(testHomeDir, { recursive: true });
  currentHomeDir = testHomeDir;
  Math.random = () => 0;
});

afterEach(() => {
  currentHomeDir = realHomeDir;
  Math.random = originalRandom;
  rmSync(testRootDir, { force: true, recursive: true });
});

function getGlobalConfigPath(): string {
  return join(testHomeDir, ".pi", "agent", "whimsical.json");
}

function writeGlobalConfig(data: unknown): void {
  mkdirSync(join(testHomeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(getGlobalConfigPath(), JSON.stringify(data));
}

function getCustomSetDirectory(): string {
  return join(testHomeDir, ".pi", "agent", "whimsical");
}

function writeCustomSetFile(name: string, data: string): void {
  const customDir = getCustomSetDirectory();
  mkdirSync(customDir, { recursive: true });
  writeFileSync(join(customDir, `${name}.json`), data);
}

function writeCustomSet(name: string, data: unknown): void {
  writeCustomSetFile(name, JSON.stringify(data));
}

function writeRawCustomSet(name: string, data: string): void {
  writeCustomSetFile(name, data);
}

function readGlobalConfig(): unknown {
  return JSON.parse(readFileSync(getGlobalConfigPath(), "utf8"));
}

function createContext(entries: readonly SessionEntryLike[] = []): {
  ctx: ExtensionCommandContext;
  notifications: NotificationUpdate[];
  workingMessages: Array<string | undefined>;
} {
  const notifications: NotificationUpdate[] = [];
  const workingMessages: Array<string | undefined> = [];

  const ctx = {
    hasUI: true,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
      setWorkingMessage(message?: string) {
        workingMessages.push(message);
      },
    },
    sessionManager: {
      getEntries() {
        return entries;
      },
    },
  } as ExtensionCommandContext;

  return { ctx, notifications, workingMessages };
}

function setupHarness(): {
  handlers: Map<string, ExtensionEventHandler>;
  command: HarnessCommandOptions;
  appendedEntries: Array<{ customType: string; data: unknown }>;
} {
  const handlers = new Map<string, ExtensionEventHandler>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  let command: RegisteredCommandOptions | undefined;

  whimsicalExtension({
    on(eventName: string, handler: ExtensionEventHandler) {
      handlers.set(eventName, handler);
    },
    registerCommand(name: string, options: RegisteredCommandOptions) {
      if (name === "whimsical") {
        command = options;
      }
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
  } as ExtensionAPI);

  if (!command) {
    throw new Error("whimsical command was not registered");
  }

  return {
    handlers,
    command: command as HarnessCommandOptions,
    appendedEntries,
  };
}

function emit(
  handlers: Map<string, ExtensionEventHandler>,
  eventName: string,
  ctx: ExtensionContext
): void {
  const handler = handlers.get(eventName);
  if (!handler) {
    throw new Error(`${eventName} handler was not registered`);
  }

  handler({}, ctx);
}

describe("whimsical extension", () => {
  it("registers the whimsical command and supported lifecycle handlers", () => {
    const { command, handlers } = setupHarness();

    expect(command.description).toContain("/whimsical [set]");
    expect([...handlers.keys()].sort()).toEqual([
      "session_start",
      "session_tree",
      "turn_end",
      "turn_start",
    ]);
  });

  it("reports current status for bare /whimsical", async () => {
    const { command } = setupHarness();
    const { ctx, notifications } = createContext();

    await command.handler("", ctx);

    expect(notifications).toEqual([
      {
        message:
          "Whimsical message set: default (default). Available: default, negative-energy",
        type: "info",
      },
    ]);
  });

  it("switches to a valid bundled set and persists command state", async () => {
    const { command, appendedEntries } = setupHarness();
    const { ctx, notifications } = createContext();

    await command.handler("negative-energy", ctx);

    expect(appendedEntries).toEqual([
      {
        customType: "whimsical:set",
        data: { selectedSet: "negative-energy" },
      },
    ]);
    expect(readGlobalConfig()).toEqual({ selectedSet: "negative-energy" });
    expect(notifications.at(-1)).toEqual({
      message:
        "Whimsical message set: negative-energy (command). Available: default, negative-energy",
      type: "info",
    });
  });

  it("warns and leaves state unchanged for unknown sets", async () => {
    const { command, appendedEntries } = setupHarness();
    const { ctx, notifications } = createContext();

    await command.handler("missing", ctx);

    expect(appendedEntries).toEqual([]);
    expect(notifications).toEqual([
      {
        message: "Usage: /whimsical [default|negative-energy]",
        type: "warning",
      },
    ]);
  });

  it("falls back stale persisted config to default and warns once", () => {
    writeGlobalConfig({ selectedSet: "missing" });
    const { handlers } = setupHarness();
    const { ctx, notifications } = createContext();

    emit(handlers, "session_start", ctx);
    emit(handlers, "session_tree", ctx);

    expect(notifications).toEqual([
      {
        message:
          'Whimsical message set "missing" is unavailable; using default.',
        type: "warning",
      },
    ]);
  });

  it("uses command state over config, picks from effective set, and clears on turn_end", () => {
    writeGlobalConfig({ selectedSet: "default" });
    const negativeEnergyMessages = JSON.parse(
      readFileSync(
        join(import.meta.dir, "messages", "negative-energy.json"),
        "utf8"
      )
    ) as string[];
    const { handlers } = setupHarness();
    const { ctx, workingMessages } = createContext([
      {
        type: "custom",
        customType: "whimsical:set",
        data: { selectedSet: "negative-energy" },
      },
    ]);

    emit(handlers, "session_start", ctx);
    emit(handlers, "turn_start", ctx);
    emit(handlers, "turn_end", ctx);

    expect(workingMessages).toEqual([negativeEnergyMessages[0], undefined]);
  });

  it("validates bundled message sets strictly", () => {
    expect(validateMessageSet("ok", ["hello"])).toEqual(["hello"]);
    expect(() => validateMessageSet("empty", [])).toThrow(
      'Invalid whimsical message set "empty": expected non-empty string array'
    );
    expect(() => validateMessageSet("bad", [""])).toThrow(
      'Invalid whimsical message set "bad": expected non-whitespace strings'
    );
    expect(() => validateMessageSet("bad", ["   "])).toThrow(
      'Invalid whimsical message set "bad": expected non-whitespace strings'
    );
    expect(() => validateMessageSet("bad", [1])).toThrow(
      'Invalid whimsical message set "bad": expected non-whitespace strings'
    );
  });

  it("provides set-name completions", () => {
    const { command } = setupHarness();

    expect(command.getArgumentCompletions?.("")).toEqual([
      { value: "default", label: "default" },
      { value: "negative-energy", label: "negative-energy" },
    ]);
    expect(command.getArgumentCompletions?.("neg")).toEqual([
      { value: "negative-energy", label: "negative-energy" },
    ]);
  });

  it("discovers valid custom sets for status, completions, and selection", async () => {
    writeCustomSet("alpha", ["custom alpha"]);
    writeCustomSet("z_bad", [""]);
    const { command, appendedEntries, handlers } = setupHarness();
    const { ctx, notifications, workingMessages } = createContext();

    expect(command.getArgumentCompletions?.("")).toEqual([
      { value: "default", label: "default" },
      { value: "negative-energy", label: "negative-energy" },
      { value: "alpha", label: "alpha" },
    ]);

    await command.handler("", ctx);
    await command.handler("alpha", ctx);
    emit(handlers, "turn_start", ctx);

    expect(appendedEntries).toEqual([
      { customType: "whimsical:set", data: { selectedSet: "alpha" } },
    ]);
    expect(readGlobalConfig()).toEqual({ selectedSet: "alpha" });
    expect(notifications.at(0)).toEqual({
      message:
        "Whimsical message set: default (default). Available: default, negative-energy, alpha",
      type: "info",
    });
    expect(notifications.at(-1)).toEqual({
      message:
        "Whimsical message set: alpha (command). Available: default, negative-energy, alpha",
      type: "info",
    });
    expect(workingMessages).toEqual(["custom alpha"]);
  });

  it("does not refresh custom set parsing during completions", async () => {
    const { command, appendedEntries } = setupHarness();
    writeCustomSet("alpha", ["custom alpha"]);
    const { ctx } = createContext();

    expect(command.getArgumentCompletions?.("alpha")).toEqual([]);
    await command.handler("alpha", ctx);

    expect(appendedEntries).toEqual([
      { customType: "whimsical:set", data: { selectedSet: "alpha" } },
    ]);
  });

  it("discovers and selects a __proto__ custom set", async () => {
    writeCustomSet("__proto__", ["custom proto"]);
    const { command, appendedEntries, handlers } = setupHarness();
    const { ctx, notifications, workingMessages } = createContext();

    expect(command.getArgumentCompletions?.("__")).toEqual([
      { value: "__proto__", label: "__proto__" },
    ]);

    await command.handler("__proto__", ctx);
    emit(handlers, "turn_start", ctx);

    expect(appendedEntries).toEqual([
      { customType: "whimsical:set", data: { selectedSet: "__proto__" } },
    ]);
    expect(notifications.at(-1)).toEqual({
      message:
        "Whimsical message set: __proto__ (command). Available: default, negative-energy, __proto__",
      type: "info",
    });
    expect(workingMessages).toEqual(["custom proto"]);
  });

  it("warns for invalid selected custom sets without full paths", () => {
    writeGlobalConfig({ selectedSet: "broken" });
    writeCustomSet("broken", ["   "]);
    const { handlers } = setupHarness();
    const { ctx, notifications } = createContext();

    emit(handlers, "session_start", ctx);

    expect(notifications).toEqual([
      {
        message:
          'Whimsical message set "broken" is invalid: expected non-whitespace strings; using default.',
        type: "warning",
      },
    ]);
    expect(notifications[0]?.message).not.toContain(testHomeDir);
  });

  it("rejects custom messages with terminal control characters", () => {
    writeGlobalConfig({ selectedSet: "escape" });
    writeCustomSet("escape", ["\u001B[2Jspoof"]);
    const { handlers } = setupHarness();
    const { ctx, notifications, workingMessages } = createContext();

    emit(handlers, "session_start", ctx);
    emit(handlers, "turn_start", ctx);

    expect(notifications).toEqual([
      {
        message:
          'Whimsical message set "escape" is invalid: expected strings without control characters; using default.',
        type: "warning",
      },
    ]);
    expect(workingMessages).not.toContain("\u001B[2Jspoof");
  });

  it("persists invalid custom selections before falling back", async () => {
    writeGlobalConfig({ selectedSet: "negative-energy" });
    writeCustomSet("broken", ["   "]);
    const { command, appendedEntries } = setupHarness();
    const { ctx, notifications } = createContext();

    await command.handler("broken", ctx);

    expect(appendedEntries).toEqual([
      { customType: "whimsical:set", data: { selectedSet: "broken" } },
    ]);
    expect(readGlobalConfig()).toEqual({ selectedSet: "broken" });
    expect(notifications.at(-1)).toEqual({
      message:
        "Whimsical message set: default (fallback (requested: broken)). Available: default, negative-energy",
      type: "info",
    });
  });

  it("reports invalid custom JSON without parser details", () => {
    writeGlobalConfig({ selectedSet: "broken" });
    writeRawCustomSet("broken", '{"secret":"do not leak"');
    const { handlers } = setupHarness();
    const { ctx, notifications } = createContext();

    emit(handlers, "session_start", ctx);

    expect(notifications).toEqual([
      {
        message:
          'Whimsical message set "broken" is invalid: invalid JSON; using default.',
        type: "warning",
      },
    ]);
    expect(notifications[0]?.message).not.toContain("secret");
  });

  it("reads custom set files with an explicit byte cap", () => {
    const customDir = getCustomSetDirectory();
    mkdirSync(customDir, { recursive: true });
    const cappedPath = join(customDir, "capped.json");
    writeFileSync(cappedPath, "x".repeat(64 * 1024 + 1));
    const fd = openSync(cappedPath, "r");

    try {
      expect(readCustomMessageSetFile(fd)).toBeUndefined();
    } finally {
      closeSync(fd);
    }
  });

  it("skips oversized selected custom sets without leaking paths", () => {
    writeGlobalConfig({ selectedSet: "huge" });
    writeCustomSet("huge", ["x".repeat(65 * 1024)]);
    const { handlers } = setupHarness();
    const { ctx, notifications } = createContext();

    emit(handlers, "session_start", ctx);

    expect(notifications).toEqual([
      {
        message:
          'Whimsical message set "huge" is invalid: file too large; using default.',
        type: "warning",
      },
    ]);
    expect(notifications[0]?.message).not.toContain(testHomeDir);
  });

  it("ignores custom sets when matching file count exceeds the custom file cap", () => {
    for (let index = 0; index <= 100; index++) {
      writeCustomSet(`set-${index}`, [`message ${index}`]);
    }
    const { command } = setupHarness();

    expect(command.getArgumentCompletions?.("set")).toEqual([]);
  });

  it("skips custom sets with too many messages", () => {
    writeGlobalConfig({ selectedSet: "noisy" });
    writeCustomSet(
      "noisy",
      Array.from({ length: 501 }, (_, index) => `message ${index}`)
    );
    const { handlers } = setupHarness();
    const { ctx, notifications } = createContext();

    emit(handlers, "session_start", ctx);

    expect(notifications).toEqual([
      {
        message:
          'Whimsical message set "noisy" is invalid: too many messages; using default.',
        type: "warning",
      },
    ]);
  });

  it("warns once and ignores custom sets when custom path is not a directory", async () => {
    mkdirSync(join(testHomeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(join(testHomeDir, ".pi", "agent", "whimsical"), "nope");
    const warn = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warn;

    try {
      const { command, handlers } = setupHarness();
      const { ctx } = createContext();

      emit(handlers, "session_start", ctx);
      await command.handler("", ctx);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(command.getArgumentCompletions?.("")).toEqual([
        { value: "default", label: "default" },
        { value: "negative-energy", label: "negative-energy" },
      ]);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("ignores symlinked custom set directories", () => {
    writeGlobalConfig({ selectedSet: "linked" });
    mkdirSync(join(testHomeDir, ".pi", "agent"), { recursive: true });
    const targetDir = join(testRootDir, "outside-whimsical");
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, "linked.json"), JSON.stringify(["linked"]));
    symlinkSync(targetDir, join(testHomeDir, ".pi", "agent", "whimsical"));
    const { handlers } = setupHarness();
    const { ctx, notifications } = createContext();

    emit(handlers, "session_start", ctx);

    expect(notifications).toEqual([
      {
        message:
          'Whimsical message set "linked" is unavailable; using default.',
        type: "warning",
      },
    ]);
  });

  it("treats invalid custom sets as shadowing bundled sets", () => {
    writeGlobalConfig({ selectedSet: "negative-energy" });
    writeCustomSet("negative-energy", [""]);
    const { handlers } = setupHarness();
    const { ctx, notifications } = createContext();

    emit(handlers, "session_start", ctx);

    expect(notifications).toEqual([
      {
        message:
          'Whimsical message set "negative-energy" is invalid: expected non-whitespace strings; using default.',
        type: "warning",
      },
    ]);
  });

  it("uses cached custom sets on session_tree refresh", () => {
    writeCustomSet("alpha", ["custom alpha"]);
    const { handlers } = setupHarness();
    rmSync(join(getCustomSetDirectory(), "alpha.json"));
    const { ctx, notifications, workingMessages } = createContext([
      {
        type: "custom",
        customType: "whimsical:set",
        data: { selectedSet: "alpha" },
      },
    ]);

    emit(handlers, "session_tree", ctx);
    emit(handlers, "turn_start", ctx);

    expect(notifications).toEqual([]);
    expect(workingMessages).toEqual(["custom alpha"]);
  });

  it("re-resolves selected custom set before reporting status", async () => {
    writeCustomSet("alpha", ["custom alpha"]);
    const { command } = setupHarness();
    rmSync(join(getCustomSetDirectory(), "alpha.json"));
    const { ctx, notifications } = createContext([
      {
        type: "custom",
        customType: "whimsical:set",
        data: { selectedSet: "alpha" },
      },
    ]);

    await command.handler("", ctx);

    expect(notifications).toEqual([
      {
        message: 'Whimsical message set "alpha" is unavailable; using default.',
        type: "warning",
      },
      {
        message:
          "Whimsical message set: default (fallback (requested: alpha)). Available: default, negative-energy",
        type: "info",
      },
    ]);
  });

  it("rejects symlinked custom set files before reading", () => {
    writeGlobalConfig({ selectedSet: "linked" });
    mkdirSync(getCustomSetDirectory(), { recursive: true });
    const targetPath = join(testRootDir, "linked-target.json");
    writeFileSync(targetPath, JSON.stringify(["linked message"]));
    symlinkSync(targetPath, join(getCustomSetDirectory(), "linked.json"));
    const { handlers } = setupHarness();
    const { ctx, notifications } = createContext();

    emit(handlers, "session_start", ctx);

    expect(notifications).toEqual([
      {
        message:
          'Whimsical message set "linked" is invalid: not a regular file; using default.',
        type: "warning",
      },
    ]);
  });

  it("uses bundled default when custom default is invalid", () => {
    writeGlobalConfig({ selectedSet: "default" });
    writeCustomSet("default", [""]);
    const bundledDefaultMessages = JSON.parse(
      readFileSync(join(import.meta.dir, "messages", "default.json"), "utf8")
    ) as string[];
    const { handlers } = setupHarness();
    const { ctx, notifications, workingMessages } = createContext();

    emit(handlers, "session_start", ctx);
    emit(handlers, "turn_start", ctx);

    expect(notifications).toEqual([]);
    expect(workingMessages).toEqual([bundledDefaultMessages[0]]);
  });

  it("uses bundled default for fallback even when custom default exists", () => {
    writeGlobalConfig({ selectedSet: "missing" });
    writeCustomSet("default", ["custom default"]);
    const bundledDefaultMessages = JSON.parse(
      readFileSync(join(import.meta.dir, "messages", "default.json"), "utf8")
    ) as string[];
    const { handlers } = setupHarness();
    const { ctx, workingMessages } = createContext();

    emit(handlers, "session_start", ctx);
    emit(handlers, "turn_start", ctx);

    expect(workingMessages).toEqual([bundledDefaultMessages[0]]);
  });
});
