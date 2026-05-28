import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir as osHomedir, hostname as osHostname } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const originalHomeDir = osHomedir();
const originalHostname = osHostname();
let currentHomeDir = originalHomeDir;
mock.module("node:os", () => ({
  homedir: () => currentHomeDir,
  hostname: () => originalHostname,
}));

const {
  applyFastModeToPayload,
  FAST_MODE_CUSTOM_TYPE,
  FAST_MODE_STATUS_KEY,
  FAST_MODE_STATUS_TEXT,
  FAST_MODE_UNSUPPORTED_STATUS_TEXT,
  FAST_MODE_WARNING,
  isFastModeEnabled,
  registerFastMode,
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

let testRootDir = "";
let testHomeDir = "";
const originalCwd = process.cwd();
const ALLOW_LIST_KEY_ERROR = /allowList/;
const ALLOWLIST_ENTRY_ERROR = /allowlist entry/;

beforeEach(() => {
  testRootDir = mkdtempSync(join("/tmp", "supa-pi-fast-"));
  testHomeDir = join(testRootDir, "home");
  mkdirSync(testHomeDir, { recursive: true });
  currentHomeDir = testHomeDir;
});

afterEach(() => {
  process.chdir(originalCwd);
  currentHomeDir = originalHomeDir;
  rmSync(testRootDir, { force: true, recursive: true });
});

function createContext(
  entries: readonly SessionEntryLike[] = [],
  model: unknown = { fastMode: true }
): {
  ctx: ExtensionCommandContext;
  statuses: Array<{ key: string; text: string | undefined }>;
  notifications: Array<{ message: string; type: string | undefined }>;
} {
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notifications: Array<{ message: string; type: string | undefined }> =
    [];

  const ctx = {
    hasUI: true,
    model,
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

function setupHarness(harnessOptions: { flag?: boolean } = {}): {
  handlers: Map<string, ExtensionEventHandler>;
  command: HarnessCommandOptions;
  appendedEntries: Array<{ customType: string; data: unknown }>;
} {
  const handlers = new Map<string, ExtensionEventHandler>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  let command: RegisteredCommandOptions | undefined;

  registerFastMode({
    on(eventName: string, handler: ExtensionEventHandler) {
      handlers.set(eventName, handler);
    },
    registerCommand(name: string, commandOptions: RegisteredCommandOptions) {
      if (name === "fast") {
        command = commandOptions;
      }
    },
    registerFlag() {
      /* noop */
    },
    getFlag(name: string) {
      return name === "fast" ? Boolean(harnessOptions.flag) : undefined;
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
  } as unknown as ExtensionAPI);

  if (!command?.handler) {
    throw new Error("fast command was not registered");
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

function getGlobalConfigPath(): string {
  return join(testHomeDir, ".pi", "agent", "fast-mode.json");
}

function readGlobalConfig(): unknown {
  return JSON.parse(readFileSync(getGlobalConfigPath(), "utf8"));
}

describe("fast mode", () => {
  it("handles on, off, and status commands", async () => {
    const { command, appendedEntries } = setupHarness();
    const { ctx, statuses, notifications } = createContext();

    await command.handler("on", ctx);
    await command.handler("status", ctx);
    await command.handler("off", ctx);

    expect(appendedEntries).toEqual([
      {
        customType: FAST_MODE_CUSTOM_TYPE,
        data: { enabled: true, warned: true },
      },
      {
        customType: FAST_MODE_CUSTOM_TYPE,
        data: { enabled: false, warned: true },
      },
    ]);
    expect(readGlobalConfig()).toEqual({
      enabled: false,
      warned: true,
      allowlist: ["openai-codex/gpt-5.5"],
    });
    expect(statuses).toEqual([
      { key: FAST_MODE_STATUS_KEY, text: FAST_MODE_STATUS_TEXT },
      { key: FAST_MODE_STATUS_KEY, text: FAST_MODE_STATUS_TEXT },
      { key: FAST_MODE_STATUS_KEY, text: undefined },
    ]);
    expect(notifications).toEqual([
      { message: FAST_MODE_WARNING, type: "warning" },
      { message: "Fast mode enabled (current model: model)", type: "info" },
      { message: "Fast mode enabled (current model: model)", type: "info" },
      { message: "Fast mode disabled", type: "info" },
    ]);
  });

  it("toggles fast mode with a bare command", async () => {
    const { command, appendedEntries } = setupHarness();
    const { ctx, statuses, notifications } = createContext();

    await command.handler("", ctx);
    await command.handler("   ", ctx);

    expect(appendedEntries).toEqual([
      {
        customType: FAST_MODE_CUSTOM_TYPE,
        data: { enabled: true, warned: true },
      },
      {
        customType: FAST_MODE_CUSTOM_TYPE,
        data: { enabled: false, warned: true },
      },
    ]);
    expect(statuses).toEqual([
      { key: FAST_MODE_STATUS_KEY, text: FAST_MODE_STATUS_TEXT },
      { key: FAST_MODE_STATUS_KEY, text: undefined },
    ]);
    expect(notifications).toEqual([
      { message: FAST_MODE_WARNING, type: "warning" },
      { message: "Fast mode enabled (current model: model)", type: "info" },
      { message: "Fast mode disabled", type: "info" },
    ]);
  });

  it("restores branch state over global fallback", () => {
    const { command } = setupHarness();
    const { ctx } = createContext();
    command.handler("on", ctx);

    const { handlers } = setupHarness();
    const restored = createContext([
      {
        type: "custom",
        customType: FAST_MODE_CUSTOM_TYPE,
        data: { enabled: false, warned: true },
      },
    ]);
    getHandler(handlers, "session_start")({}, restored.ctx);

    expect(isFastModeEnabled()).toBe(false);
    expect(restored.statuses).toEqual([
      { key: FAST_MODE_STATUS_KEY, text: undefined },
    ]);
  });

  it("restores branch state on session tree navigation", () => {
    const { command } = setupHarness();
    const { ctx } = createContext();
    command.handler("on", ctx);

    const { handlers } = setupHarness();
    const restored = createContext([
      {
        type: "custom",
        customType: FAST_MODE_CUSTOM_TYPE,
        data: { enabled: false, warned: true },
      },
    ]);
    getHandler(handlers, "session_tree")({}, restored.ctx);

    expect(isFastModeEnabled()).toBe(false);
    expect(restored.statuses).toEqual([
      { key: FAST_MODE_STATUS_KEY, text: undefined },
    ]);
  });

  it("lets --fast force and persist enabled", () => {
    const { handlers, appendedEntries } = setupHarness({ flag: true });
    const { ctx } = createContext([
      {
        type: "custom",
        customType: FAST_MODE_CUSTOM_TYPE,
        data: { enabled: false, warned: true },
      },
    ]);

    getHandler(handlers, "session_start")({}, ctx);

    expect(isFastModeEnabled()).toBe(true);
    expect(appendedEntries).toEqual([
      {
        customType: FAST_MODE_CUSTOM_TYPE,
        data: { enabled: true, warned: false },
      },
    ]);
    expect(readGlobalConfig()).toEqual({
      enabled: true,
      warned: false,
      allowlist: ["openai-codex/gpt-5.5"],
    });
  });

  it("fails fast for malformed persisted global state", () => {
    mkdirSync(join(testHomeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(getGlobalConfigPath(), "not json");

    expect(() => setupHarness()).toThrow();
  });

  it("fails fast for invalid allowlist and common typo keys", () => {
    mkdirSync(join(testHomeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      JSON.stringify({ enabled: false, warned: false, allowList: [] })
    );
    expect(() => setupHarness()).toThrow(ALLOW_LIST_KEY_ERROR);

    writeFileSync(
      getGlobalConfigPath(),
      JSON.stringify({ enabled: false, warned: false, allowlist: ["gpt-5.5"] })
    );
    expect(() => setupHarness()).toThrow(ALLOWLIST_ENTRY_ERROR);
  });

  it("does not enable in memory when persistence fails", () => {
    const { command, appendedEntries } = setupHarness();
    const { ctx, statuses, notifications } = createContext();
    mkdirSync(join(testHomeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      JSON.stringify({ enabled: false, warned: false, allowList: [] })
    );

    expect(() => command.handler("on", ctx)).toThrow(ALLOW_LIST_KEY_ERROR);

    expect(isFastModeEnabled()).toBe(false);
    expect(appendedEntries).toEqual([]);
    expect(statuses).toEqual([]);
    expect(notifications).toEqual([]);
    expect(
      applyFastModeToPayload({ model: "x" }, isFastModeEnabled(), {
        fastMode: true,
      })
    ).toBeUndefined();
  });

  it("preserves unknown keys and user allowlist on state writes", async () => {
    mkdirSync(join(testHomeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      JSON.stringify({
        enabled: false,
        warned: false,
        allowlist: ["custom-provider/custom-model"],
        note: "keep me",
      })
    );

    const { command } = setupHarness();
    const { ctx } = createContext([], {
      provider: "custom-provider",
      id: "custom-model",
    });
    await command.handler("on", ctx);

    expect(readGlobalConfig()).toEqual({
      enabled: true,
      warned: true,
      allowlist: ["custom-provider/custom-model"],
      note: "keep me",
    });
  });

  it("supports config allowlist and canonical model ids", () => {
    mkdirSync(join(testHomeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      JSON.stringify({
        enabled: false,
        warned: false,
        allowlist: ["custom-provider/custom-model"],
      })
    );
    setupHarness();

    expect(
      applyFastModeToPayload({}, true, {
        provider: "custom-provider",
        id: "custom-model",
      })
    ).toEqual({ service_tier: "priority" });
    expect(
      applyFastModeToPayload({}, true, { id: "custom-provider/custom-model" })
    ).toEqual({ service_tier: "priority" });
  });

  it("reloads config allowlist before applying session state", () => {
    mkdirSync(join(testHomeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      JSON.stringify({
        enabled: false,
        warned: false,
        allowlist: ["old-provider/old-model"],
      })
    );
    const { handlers } = setupHarness();
    writeFileSync(
      getGlobalConfigPath(),
      JSON.stringify({
        enabled: false,
        warned: false,
        allowlist: ["new-provider/new-model"],
      })
    );
    const restored = createContext([
      {
        type: "custom",
        customType: FAST_MODE_CUSTOM_TYPE,
        data: { enabled: true, warned: true },
      },
    ]);

    getHandler(handlers, "session_start")({}, restored.ctx);

    expect(isFastModeEnabled()).toBe(true);
    expect(
      applyFastModeToPayload({}, true, {
        provider: "old-provider",
        id: "old-model",
      })
    ).toBeUndefined();
    expect(
      applyFastModeToPayload({}, true, {
        provider: "new-provider",
        id: "new-model",
      })
    ).toEqual({ service_tier: "priority" });
  });

  it("derives model capability from structural fastMode true and local allowlist", () => {
    expect(applyFastModeToPayload({}, true, { fastMode: true })).toEqual({
      service_tier: "priority",
    });
    expect(
      applyFastModeToPayload({}, true, {
        provider: "openai-codex",
        id: "gpt-5.5",
      })
    ).toEqual({
      service_tier: "priority",
    });
    expect(
      applyFastModeToPayload({}, true, { fastMode: false })
    ).toBeUndefined();
    expect(applyFastModeToPayload({}, true, {})).toBeUndefined();
  });

  it("patches request payload only when enabled and supported", () => {
    expect(
      applyFastModeToPayload({ model: "x" }, true, { fastMode: true })
    ).toEqual({
      model: "x",
      service_tier: "priority",
    });
    expect(
      applyFastModeToPayload({ model: "x" }, false, { fastMode: true })
    ).toBeUndefined();
  });

  it("does not overwrite existing service tier fields", () => {
    expect(
      applyFastModeToPayload({ service_tier: "default" }, true, {
        fastMode: true,
      })
    ).toBeUndefined();
    expect(
      applyFastModeToPayload({ serviceTier: "default" }, true, {
        fastMode: true,
      })
    ).toBeUndefined();
  });

  it("keeps unsupported models enabled but marks status unsupported", async () => {
    const { command } = setupHarness();
    const { ctx, statuses, notifications } = createContext([], {
      fastMode: false,
    });

    await command.handler("on", ctx);

    expect(isFastModeEnabled()).toBe(true);
    expect(statuses.at(-1)).toEqual({
      key: FAST_MODE_STATUS_KEY,
      text: FAST_MODE_UNSUPPORTED_STATUS_TEXT,
    });
    expect(notifications.at(-1)).toEqual({
      message: "Fast mode enabled (current model: unsupported)",
      type: "info",
    });
  });

  it("refreshes status after model selection", async () => {
    const { command, handlers } = setupHarness();
    const supported = createContext([], { fastMode: true });
    await command.handler("on", supported.ctx);

    const unsupported = createContext([], { fastMode: false });
    getHandler(handlers, "model_select")({}, unsupported.ctx);

    expect(unsupported.statuses).toEqual([
      {
        key: FAST_MODE_STATUS_KEY,
        text: FAST_MODE_UNSUPPORTED_STATUS_TEXT,
      },
    ]);
  });

  it("warns only once when first enabling", async () => {
    const { command } = setupHarness();
    const { ctx, notifications } = createContext();

    await command.handler("on", ctx);
    await command.handler("off", ctx);
    await command.handler("on", ctx);

    expect(
      notifications.filter((item) => item.message === FAST_MODE_WARNING)
    ).toHaveLength(1);
  });

  it("applies priority service tier from provider hook", () => {
    const { command, handlers } = setupHarness();
    const ctx = createContext([], { fastMode: true }).ctx;
    const request = { payload: { model: "x" } };

    command.handler("on", ctx);
    const result = getHandler(handlers, "before_provider_request")(
      request,
      ctx as ExtensionContext
    );

    expect(result).toEqual({ model: "x", service_tier: "priority" });
  });
});
