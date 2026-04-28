import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  EventBus,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

let currentHomeDir = "";
mock.module("node:os", () => ({
  homedir: () => currentHomeDir,
}));

const {
  CAVEMAN_MODE_CUSTOM_TYPE,
  CAVEMAN_MODE_PROMPT,
  CAVEMAN_MODE_STATUS_KEY,
  CAVEMAN_MODE_STATUS_TEXT,
  CAVEMAN_RPC_APPLY_CHANNEL,
  CAVEMAN_RPC_CAPABILITIES_CHANNEL,
  isCavemanModeEnabled,
  LEGACY_CAVEMAN_MODE_CUSTOM_TYPE,
  registerCavemanMode,
} = await import("./caveman-mode");

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

interface StatusUpdate {
  key: string;
  text: string | undefined;
}

interface NotificationUpdate {
  message: string;
  type: string | undefined;
}

let testRootDir = "";
let testHomeDir = "";
let testProjectDir = "";
const originalCwd = process.cwd();

beforeEach(() => {
  testRootDir = mkdtempSync(join("/tmp", "supa-pi-caveman-"));
  testHomeDir = join(testRootDir, "home");
  testProjectDir = join(testRootDir, "project");
  mkdirSync(testHomeDir, { recursive: true });
  mkdirSync(testProjectDir, { recursive: true });
  currentHomeDir = testHomeDir;
  process.chdir(testProjectDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  currentHomeDir = "";
  rmSync(testRootDir, { force: true, recursive: true });
});

function writeConfig(configDir: string, data: unknown): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "caveman.json"),
    typeof data === "string" ? data : JSON.stringify(data)
  );
}

function writeGlobalConfig(data: unknown): void {
  writeConfig(join(testHomeDir, ".pi", "agent"), data);
}

function writeProjectConfig(projectDir: string, data: unknown): void {
  writeConfig(join(projectDir, ".pi"), data);
}

function createContext(
  entries: readonly SessionEntryLike[] = [],
  options: { cwd?: string } = {}
): {
  ctx: ExtensionCommandContext;
  statuses: StatusUpdate[];
  notifications: NotificationUpdate[];
} {
  const statuses: StatusUpdate[] = [];
  const notifications: NotificationUpdate[] = [];

  const ctx = {
    cwd: options.cwd ?? testProjectDir,
    hasUI: true,
    ui: {
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
    },
    sessionManager: {
      getEntries() {
        return entries;
      },
    },
  } as ExtensionCommandContext;

  return { ctx, statuses, notifications };
}

function setupHarness(): {
  handlers: Map<string, ExtensionEventHandler>;
  eventHandlers: Map<string, ExtensionEventHandler>;
  command: HarnessCommandOptions;
  appendedEntries: Array<{ customType: string; data: unknown }>;
} {
  const handlers = new Map<string, ExtensionEventHandler>();
  const eventHandlers = new Map<string, ExtensionEventHandler>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  let command: RegisteredCommandOptions | undefined;

  const events = {
    emit() {
      /* noop */
    },
    on(channel: string, handler: ExtensionEventHandler) {
      eventHandlers.set(channel, handler);
      return () => {
        eventHandlers.delete(channel);
      };
    },
  } as EventBus;

  registerCavemanMode({
    events,
    on(eventName: string, handler: ExtensionEventHandler) {
      handlers.set(eventName, handler);
    },
    registerCommand(name: string, options: RegisteredCommandOptions) {
      if (name === "caveman") {
        command = options;
      }
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
  } as ExtensionAPI);

  if (!command) {
    throw new Error("caveman command was not registered");
  }

  return {
    handlers,
    eventHandlers,
    command: command as HarnessCommandOptions,
    appendedEntries,
  };
}

function getHandler(
  handlers: Map<string, ExtensionEventHandler>,
  eventName: string
): ExtensionEventHandler {
  const handler = handlers.get(eventName);
  if (!handler) {
    throw new Error(`${eventName} handler was not registered`);
  }

  return handler;
}

describe("caveman mode", () => {
  it("handles on, off, status, and toggle commands", async () => {
    const { command, appendedEntries } = setupHarness();
    const { ctx, statuses, notifications } = createContext();

    await command.handler("on", ctx);
    await command.handler("status", ctx);
    await command.handler("off", ctx);
    await command.handler("status", ctx);
    await command.handler("on", ctx);
    await command.handler("toggle", ctx);

    expect(appendedEntries).toEqual([
      { customType: CAVEMAN_MODE_CUSTOM_TYPE, data: { enabled: true } },
      { customType: CAVEMAN_MODE_CUSTOM_TYPE, data: { enabled: false } },
      { customType: CAVEMAN_MODE_CUSTOM_TYPE, data: { enabled: true } },
      { customType: CAVEMAN_MODE_CUSTOM_TYPE, data: { enabled: false } },
    ]);
    expect(statuses).toEqual([
      { key: CAVEMAN_MODE_STATUS_KEY, text: CAVEMAN_MODE_STATUS_TEXT },
      { key: CAVEMAN_MODE_STATUS_KEY, text: CAVEMAN_MODE_STATUS_TEXT },
      { key: CAVEMAN_MODE_STATUS_KEY, text: undefined },
      { key: CAVEMAN_MODE_STATUS_KEY, text: undefined },
      { key: CAVEMAN_MODE_STATUS_KEY, text: CAVEMAN_MODE_STATUS_TEXT },
      { key: CAVEMAN_MODE_STATUS_KEY, text: undefined },
    ]);
    expect(notifications).toEqual([
      { message: "Caveman mode enabled", type: "info" },
      { message: "Caveman mode enabled", type: "info" },
      { message: "Caveman mode disabled", type: "info" },
      { message: "Caveman mode disabled", type: "info" },
      { message: "Caveman mode enabled", type: "info" },
      { message: "Caveman mode disabled", type: "info" },
    ]);
  });

  it("restores latest valid session state on session_start", () => {
    const { handlers, appendedEntries } = setupHarness();
    const entries: SessionEntryLike[] = [
      {
        type: "custom",
        customType: CAVEMAN_MODE_CUSTOM_TYPE,
        data: { enabled: false },
      },
      {
        type: "custom",
        customType: CAVEMAN_MODE_CUSTOM_TYPE,
        data: { enabled: true },
      },
      {
        type: "custom",
        customType: CAVEMAN_MODE_CUSTOM_TYPE,
        data: { enabled: "nope" },
      },
    ];
    const { ctx, statuses } = createContext(entries);

    getHandler(handlers, "session_start")({ type: "session_start" }, ctx);

    expect(appendedEntries).toEqual([]);
    expect(isCavemanModeEnabled()).toBe(true);
    expect(statuses).toEqual([
      { key: CAVEMAN_MODE_STATUS_KEY, text: CAVEMAN_MODE_STATUS_TEXT },
    ]);
  });

  it("restores legacy pieditor session state", () => {
    const { handlers } = setupHarness();
    const { ctx, statuses } = createContext([
      {
        type: "custom",
        customType: LEGACY_CAVEMAN_MODE_CUSTOM_TYPE,
        data: { enabled: true },
      },
    ]);

    getHandler(handlers, "session_start")({ type: "session_start" }, ctx);

    expect(isCavemanModeEnabled()).toBe(true);
    expect(statuses).toEqual([
      { key: CAVEMAN_MODE_STATUS_KEY, text: CAVEMAN_MODE_STATUS_TEXT },
    ]);
  });

  it("uses global config as the default state", () => {
    writeGlobalConfig({ enabled: true });
    const { handlers, appendedEntries } = setupHarness();
    const { ctx, statuses } = createContext();

    getHandler(handlers, "session_start")({ type: "session_start" }, ctx);

    expect(appendedEntries).toEqual([]);
    expect(isCavemanModeEnabled()).toBe(true);
    expect(statuses).toEqual([
      { key: CAVEMAN_MODE_STATUS_KEY, text: CAVEMAN_MODE_STATUS_TEXT },
    ]);
  });

  it("lets project config override global config", () => {
    writeGlobalConfig({ enabled: true });
    writeProjectConfig(testProjectDir, { enabled: false });
    const { handlers } = setupHarness();
    const { ctx, statuses } = createContext();

    getHandler(handlers, "session_start")({ type: "session_start" }, ctx);

    expect(isCavemanModeEnabled()).toBe(false);
    expect(statuses).toEqual([
      { key: CAVEMAN_MODE_STATUS_KEY, text: undefined },
    ]);
  });

  it("lets latest session state override config, including legacy entries", () => {
    writeGlobalConfig({ enabled: true });
    const { handlers, appendedEntries } = setupHarness();
    const { ctx, statuses } = createContext([
      {
        type: "custom",
        customType: CAVEMAN_MODE_CUSTOM_TYPE,
        data: { enabled: true },
      },
      {
        type: "custom",
        customType: LEGACY_CAVEMAN_MODE_CUSTOM_TYPE,
        data: { enabled: false },
      },
    ]);

    getHandler(handlers, "session_start")({ type: "session_start" }, ctx);

    expect(appendedEntries).toEqual([]);
    expect(isCavemanModeEnabled()).toBe(false);
    expect(statuses).toEqual([
      { key: CAVEMAN_MODE_STATUS_KEY, text: undefined },
    ]);
  });

  it("recomputes config-derived state on session_switch", () => {
    writeProjectConfig(testProjectDir, { enabled: true });
    const otherProjectDir = join(testRootDir, "other-project");
    mkdirSync(otherProjectDir, { recursive: true });
    writeProjectConfig(otherProjectDir, { enabled: false });
    const { handlers, appendedEntries } = setupHarness();
    const sessionStart = getHandler(handlers, "session_start");
    const sessionSwitch = getHandler(handlers, "session_switch");
    const { ctx: firstCtx, statuses: firstStatuses } = createContext();
    const { ctx: secondCtx, statuses: secondStatuses } = createContext([], {
      cwd: otherProjectDir,
    });

    sessionStart({ type: "session_start" }, firstCtx);
    sessionSwitch({ type: "session_switch" }, secondCtx);

    expect(appendedEntries).toEqual([]);
    expect(firstStatuses).toEqual([
      { key: CAVEMAN_MODE_STATUS_KEY, text: CAVEMAN_MODE_STATUS_TEXT },
    ]);
    expect(secondStatuses).toEqual([
      { key: CAVEMAN_MODE_STATUS_KEY, text: undefined },
    ]);
    expect(isCavemanModeEnabled()).toBe(false);
  });

  it("falls back from malformed project config to global config", () => {
    writeGlobalConfig({ enabled: true });
    writeProjectConfig(testProjectDir, "{");
    const { handlers } = setupHarness();
    const { ctx, statuses } = createContext();

    getHandler(handlers, "session_start")({ type: "session_start" }, ctx);

    expect(isCavemanModeEnabled()).toBe(true);
    expect(statuses).toEqual([
      { key: CAVEMAN_MODE_STATUS_KEY, text: CAVEMAN_MODE_STATUS_TEXT },
    ]);
  });

  it("falls back to disabled when config shape is invalid", () => {
    writeGlobalConfig({ enabled: "yes" });
    const { handlers } = setupHarness();
    const { ctx, statuses } = createContext();

    getHandler(handlers, "session_start")({ type: "session_start" }, ctx);

    expect(isCavemanModeEnabled()).toBe(false);
    expect(statuses).toEqual([
      { key: CAVEMAN_MODE_STATUS_KEY, text: undefined },
    ]);
  });

  it("keeps /caveman status boolean-only for config-derived state", async () => {
    writeGlobalConfig({ enabled: true });
    const { command, handlers, appendedEntries } = setupHarness();
    const { ctx, statuses, notifications } = createContext();

    getHandler(handlers, "session_start")({ type: "session_start" }, ctx);
    await command.handler("status", ctx);

    expect(appendedEntries).toEqual([]);
    expect(statuses).toEqual([
      { key: CAVEMAN_MODE_STATUS_KEY, text: CAVEMAN_MODE_STATUS_TEXT },
      { key: CAVEMAN_MODE_STATUS_KEY, text: CAVEMAN_MODE_STATUS_TEXT },
    ]);
    expect(notifications).toEqual([
      { message: "Caveman mode enabled", type: "info" },
    ]);
  });

  it("appends caveman prompt only while active", () => {
    const { handlers } = setupHarness();
    const beforeAgentStart = getHandler(handlers, "before_agent_start");
    const inactiveResult = beforeAgentStart({
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "base",
    });
    const inactiveWithExistingPromptResult = beforeAgentStart({
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: `base\n\n${CAVEMAN_MODE_PROMPT}`,
    });

    expect(inactiveResult).toBeUndefined();
    expect(inactiveWithExistingPromptResult).toBeUndefined();

    const { ctx } = createContext([
      {
        type: "custom",
        customType: CAVEMAN_MODE_CUSTOM_TYPE,
        data: { enabled: true },
      },
    ]);

    getHandler(handlers, "session_start")({ type: "session_start" }, ctx);
    const activeResult = beforeAgentStart({
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "base",
    }) as { systemPrompt?: string } | undefined;

    expect(activeResult?.systemPrompt).toBe(`base\n\n${CAVEMAN_MODE_PROMPT}`);
  });

  it("clears status when no valid session state exists", () => {
    const { handlers } = setupHarness();
    const { ctx, statuses } = createContext([
      {
        type: "custom",
        customType: CAVEMAN_MODE_CUSTOM_TYPE,
        data: { enabled: "nope" },
      },
    ]);

    getHandler(handlers, "session_start")({ type: "session_start" }, ctx);

    expect(statuses).toEqual([
      { key: CAVEMAN_MODE_STATUS_KEY, text: undefined },
    ]);
  });

  it("returns RPC capabilities", () => {
    const { eventHandlers } = setupHarness();
    const capabilities = getHandler(
      eventHandlers,
      CAVEMAN_RPC_CAPABILITIES_CHANNEL
    );

    expect(capabilities({ requestId: "capabilities-1" })).toEqual({
      success: true,
      data: { version: 1, supportsApply: true },
    });
  });

  it("applies caveman instructions through RPC when enabled", () => {
    const { eventHandlers } = setupHarness();
    const apply = getHandler(eventHandlers, CAVEMAN_RPC_APPLY_CHANNEL);

    expect(
      apply({
        requestId: "apply-1",
        version: 1,
        enabled: true,
        systemPrompt: "base",
      })
    ).toEqual({
      success: true,
      data: { version: 1, systemPrompt: `base\n\n${CAVEMAN_MODE_PROMPT}` },
    });
  });

  it("removes caveman instructions through RPC when disabled", () => {
    const { eventHandlers } = setupHarness();
    const apply = getHandler(eventHandlers, CAVEMAN_RPC_APPLY_CHANNEL);

    expect(
      apply({
        requestId: "apply-2",
        version: 1,
        enabled: false,
        systemPrompt: `base\n\n${CAVEMAN_MODE_PROMPT}`,
      })
    ).toEqual({
      success: true,
      data: { version: 1, systemPrompt: "base" },
    });
  });

  it("keeps caveman RPC apply idempotent", () => {
    const { eventHandlers } = setupHarness();
    const apply = getHandler(eventHandlers, CAVEMAN_RPC_APPLY_CHANNEL);
    const duplicatePrompt = `base\n\n${CAVEMAN_MODE_PROMPT}\n\n${CAVEMAN_MODE_PROMPT}`;

    expect(
      apply({
        requestId: "apply-3",
        version: 1,
        enabled: true,
        systemPrompt: duplicatePrompt,
      })
    ).toEqual({
      success: true,
      data: { version: 1, systemPrompt: `base\n\n${CAVEMAN_MODE_PROMPT}` },
    });
  });
});
