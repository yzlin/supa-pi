import { describe, expect, it } from "bun:test";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import {
  CAVEMAN_MODE_CUSTOM_TYPE,
  CAVEMAN_MODE_PROMPT,
  CAVEMAN_MODE_STATUS_KEY,
  CAVEMAN_MODE_STATUS_TEXT,
  isCavemanModeEnabled,
  LEGACY_CAVEMAN_MODE_CUSTOM_TYPE,
  registerCavemanMode,
} from "./caveman-mode";

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

function createContext(entries: readonly SessionEntryLike[] = []): {
  ctx: ExtensionCommandContext;
  statuses: Array<{ key: string; text: string | undefined }>;
  notifications: Array<{ message: string; type: string | undefined }>;
} {
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notifications: Array<{ message: string; type: string | undefined }> =
    [];

  const ctx = {
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
  command: HarnessCommandOptions;
  appendedEntries: Array<{ customType: string; data: unknown }>;
} {
  const handlers = new Map<string, ExtensionEventHandler>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  let command: RegisteredCommandOptions | undefined;

  registerCavemanMode({
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

  it("appends caveman prompt only while active", () => {
    const { handlers } = setupHarness();
    const beforeAgentStart = getHandler(handlers, "before_agent_start");
    const inactiveResult = beforeAgentStart({
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "base",
    });

    expect(inactiveResult).toBeUndefined();

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
});
