import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

let currentHomeDir = "";
mock.module("node:os", () => ({
  homedir: () => currentHomeDir,
}));

const { default: whimsicalExtension, validateMessageSet } = await import(
  "./index"
);

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
  currentHomeDir = "";
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
      'Invalid whimsical message set "bad": expected non-empty strings'
    );
    expect(() => validateMessageSet("bad", [1])).toThrow(
      'Invalid whimsical message set "bad": expected non-empty strings'
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
});
