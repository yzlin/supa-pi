/*
 * Adapted from `agent-stuff` by original author Armin Ronacher (mitsuhiko).
 * Source: https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/whimsical.ts
 * Original license: Apache License 2.0.
 */

import type { Dir } from "node:fs";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const WHIMSICAL_CUSTOM_TYPE = "whimsical:set";
const DEFAULT_SET_NAME = "default";
const MESSAGE_SET_NAMES = [DEFAULT_SET_NAME, "negative-energy"] as const;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CUSTOM_SET_FILENAME_PATTERN = /^[a-z0-9_-]+\.json$/;
const INVALID_MESSAGE_SET_PREFIX_PATTERN =
  /^Invalid whimsical message set "[^"]+": /;
const WHITESPACE_PATTERN = /\s+/;
const MAX_CUSTOM_SET_FILES = 100;
const MAX_CUSTOM_SET_DIRECTORY_ENTRIES = 1000;
const MAX_CUSTOM_SET_FILE_BYTES = 64 * 1024;
const MAX_CUSTOM_SET_MESSAGES = 500;
const MAX_CUSTOM_SET_MESSAGE_BYTES = 32 * 1024;
const CUSTOM_SET_OPEN_FLAGS =
  constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK;

type BundledMessageSetName = (typeof MESSAGE_SET_NAMES)[number];
type SelectionSource = "command" | "config" | "default" | "fallback";

interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

interface WhimsicalState {
  selectedSet: string;
}

interface ResolvedWhimsicalState {
  selectedSet: string;
  requestedSet: string;
  source: SelectionSource;
  warning?: string;
}

interface CustomMessageSets {
  sets: Record<string, string[]>;
  invalidReasons: Record<string, string>;
}

let selectedSet = DEFAULT_SET_NAME;
let selectedSetSource: SelectionSource = "default";
let requestedSet = DEFAULT_SET_NAME;
const warnedFallbackMessages = new Set<string>();
let warnedCustomDirectory = false;

export function validateMessageSet(name: string, data: unknown): string[] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(
      `Invalid whimsical message set "${name}": expected non-empty string array`
    );
  }

  for (const message of data) {
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new Error(
        `Invalid whimsical message set "${name}": expected non-whitespace strings`
      );
    }
  }

  return data;
}

function loadBundledMessageSet(name: BundledMessageSetName): string[] {
  const path = join(MODULE_DIR, "messages", `${name}.json`);
  return validateMessageSet(name, JSON.parse(readFileSync(path, "utf8")));
}

const bundledMessageSets: Record<BundledMessageSetName, string[]> = {
  default: loadBundledMessageSet("default"),
  "negative-energy": loadBundledMessageSet("negative-energy"),
};

function hasOwn<T extends object>(object: T, key: PropertyKey): key is keyof T {
  return Object.hasOwn(object, key);
}

function isBundledMessageSetName(
  value: string
): value is BundledMessageSetName {
  return MESSAGE_SET_NAMES.includes(value as BundledMessageSetName);
}

function createStringRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function createEmptyCustomMessageSets(): CustomMessageSets {
  return {
    invalidReasons: createStringRecord(),
    sets: createStringRecord(),
  };
}

let customMessageSets = createEmptyCustomMessageSets();
let messageSets: Record<string, string[]> = { ...bundledMessageSets };

function getCustomMessageSetDirectory(homeDir = homedir()): string {
  return join(homeDir, ".pi", "agent", "whimsical");
}

function formatValidationReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return "invalid JSON";
  }

  return error.message.replace(INVALID_MESSAGE_SET_PREFIX_PATTERN, "");
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0x00 && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }

  return false;
}

function validateCustomMessageSet(name: string, data: unknown): string[] {
  const messages = validateMessageSet(name, data);
  if (messages.length > MAX_CUSTOM_SET_MESSAGES) {
    throw new Error(
      `Invalid whimsical message set "${name}": too many messages`
    );
  }

  for (const message of messages) {
    if (hasControlCharacter(message)) {
      throw new Error(
        `Invalid whimsical message set "${name}": expected strings without control characters`
      );
    }
  }

  const messageBytes = Buffer.byteLength(messages.join(""), "utf8");
  if (messageBytes > MAX_CUSTOM_SET_MESSAGE_BYTES) {
    throw new Error(
      `Invalid whimsical message set "${name}": messages too large`
    );
  }

  return messages;
}

function warnUnreadableCustomDirectory(): void {
  if (!warnedCustomDirectory) {
    warnedCustomDirectory = true;
    console.warn(
      "Whimsical custom message directory is not readable; ignoring custom sets."
    );
  }
}

export function readCustomMessageSetFile(fd: number): string | undefined {
  const buffer = Buffer.allocUnsafe(MAX_CUSTOM_SET_FILE_BYTES + 1);
  const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
  if (bytesRead > MAX_CUSTOM_SET_FILE_BYTES) {
    return;
  }

  return buffer.toString("utf8", 0, bytesRead);
}

function loadCustomMessageSets(customDirectory: string): CustomMessageSets {
  if (!existsSync(customDirectory)) {
    return createEmptyCustomMessageSets();
  }

  try {
    const directoryStats = lstatSync(customDirectory);
    if (!directoryStats.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    warnUnreadableCustomDirectory();
    return createEmptyCustomMessageSets();
  }

  const sets = createStringRecord<string[]>();
  const invalidReasons = createStringRecord<string>();
  const customEntries: string[] = [];

  let directory: Dir | undefined;
  try {
    directory = opendirSync(customDirectory);
    let scannedEntries = 0;
    let entry = directory.readSync();
    while (entry) {
      scannedEntries += 1;
      if (scannedEntries > MAX_CUSTOM_SET_DIRECTORY_ENTRIES) {
        return createEmptyCustomMessageSets();
      }

      if (CUSTOM_SET_FILENAME_PATTERN.test(entry.name)) {
        customEntries.push(entry.name);
        if (customEntries.length > MAX_CUSTOM_SET_FILES) {
          return createEmptyCustomMessageSets();
        }
      }

      entry = directory.readSync();
    }
  } catch {
    warnUnreadableCustomDirectory();
    return createEmptyCustomMessageSets();
  } finally {
    directory?.closeSync();
  }

  customEntries.sort();

  for (const entry of customEntries) {
    const name = entry.slice(0, -".json".length);
    const path = join(customDirectory, entry);
    let raw: string;
    let fd: number | undefined;
    try {
      fd = openSync(path, CUSTOM_SET_OPEN_FLAGS);
      const fileStats = fstatSync(fd);
      if (!fileStats.isFile()) {
        invalidReasons[name] = "not a regular file";
        continue;
      }
      if (fileStats.size > MAX_CUSTOM_SET_FILE_BYTES) {
        invalidReasons[name] = "file too large";
        continue;
      }
      const cappedRaw = readCustomMessageSetFile(fd);
      if (cappedRaw === undefined) {
        invalidReasons[name] = "file too large";
        continue;
      }
      raw = cappedRaw;
    } catch (error) {
      invalidReasons[name] =
        error instanceof Error && "code" in error && error.code === "ELOOP"
          ? "not a regular file"
          : "unreadable file";
      continue;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      invalidReasons[name] = "invalid JSON";
      continue;
    }

    try {
      sets[name] = validateCustomMessageSet(name, parsed);
    } catch (error) {
      invalidReasons[name] = formatValidationReason(error);
    }
  }

  return { invalidReasons, sets };
}

function refreshMessageSets(): void {
  customMessageSets = loadCustomMessageSets(getCustomMessageSetDirectory());
  messageSets = { ...bundledMessageSets, ...customMessageSets.sets };
}

function getAvailableMessageSetNames(): string[] {
  const bundled = [...MESSAGE_SET_NAMES];
  const custom = Object.keys(customMessageSets.sets).sort();
  return [...new Set([...bundled, ...custom])];
}

function pickRandom(): string {
  const messages =
    selectedSetSource === "fallback"
      ? bundledMessageSets.default
      : (messageSets[selectedSet] ?? bundledMessageSets.default);
  return messages[Math.floor(Math.random() * messages.length)];
}

function parseWhimsicalState(data: unknown): WhimsicalState | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const state = data as { selectedSet?: unknown };
  if (typeof state.selectedSet !== "string" || state.selectedSet.length === 0) {
    return null;
  }

  return { selectedSet: state.selectedSet };
}

function isWhimsicalEntry(
  entry: SessionEntryLike | undefined
): entry is SessionEntryLike {
  return entry?.type === "custom" && entry.customType === WHIMSICAL_CUSTOM_TYPE;
}

function getLatestWhimsicalState(
  entries: readonly SessionEntryLike[]
): WhimsicalState | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isWhimsicalEntry(entry)) {
      continue;
    }

    const state = parseWhimsicalState(entry.data);
    if (state) {
      return state;
    }
  }

  return null;
}

function getGlobalWhimsicalConfigPath(homeDir = homedir()): string {
  return join(homeDir, ".pi", "agent", "whimsical.json");
}

function loadWhimsicalConfigFile(configPath: string): WhimsicalState | null {
  if (!existsSync(configPath)) {
    return null;
  }

  const state = parseWhimsicalState(
    JSON.parse(readFileSync(configPath, "utf8"))
  );
  if (!state) {
    throw new Error(`Invalid whimsical config file: ${configPath}`);
  }

  return state;
}

function writeWhimsicalConfigFile(
  state: WhimsicalState,
  homeDir = homedir()
): void {
  const configPath = getGlobalWhimsicalConfigPath(homeDir);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(state, null, 2)}\n`);
}

function resolveSelectedSet(
  state: WhimsicalState | null,
  source: SelectionSource
): ResolvedWhimsicalState {
  if (!state) {
    return {
      selectedSet: DEFAULT_SET_NAME,
      requestedSet: DEFAULT_SET_NAME,
      source: "default",
    };
  }

  if (
    state.selectedSet !== DEFAULT_SET_NAME &&
    hasOwn(customMessageSets.invalidReasons, state.selectedSet)
  ) {
    const invalidReason = customMessageSets.invalidReasons[state.selectedSet];
    return {
      selectedSet: DEFAULT_SET_NAME,
      requestedSet: state.selectedSet,
      source: "fallback",
      warning: `Whimsical message set "${state.selectedSet}" is invalid: ${invalidReason}; using default.`,
    };
  }

  if (
    hasOwn(customMessageSets.sets, state.selectedSet) ||
    isBundledMessageSetName(state.selectedSet)
  ) {
    return {
      selectedSet: state.selectedSet,
      requestedSet: state.selectedSet,
      source,
    };
  }

  return {
    selectedSet: DEFAULT_SET_NAME,
    requestedSet: state.selectedSet,
    source: "fallback",
    warning: `Whimsical message set "${state.selectedSet}" is unavailable; using default.`,
  };
}

function resolveWhimsicalState(
  entries: readonly SessionEntryLike[],
  options: { refreshMessageSets?: boolean } = {}
): ResolvedWhimsicalState {
  if (options.refreshMessageSets !== false) {
    refreshMessageSets();
  }
  const commandState = getLatestWhimsicalState(entries);
  if (commandState) {
    return resolveSelectedSet(commandState, "command");
  }

  const configState = loadWhimsicalConfigFile(getGlobalWhimsicalConfigPath());
  return resolveSelectedSet(configState, "config");
}

function applyResolvedState(
  state: ResolvedWhimsicalState,
  ctx?: ExtensionContext
): void {
  selectedSet = state.selectedSet;
  selectedSetSource = state.source;
  requestedSet = state.requestedSet;

  if (
    ctx &&
    state.source === "fallback" &&
    state.warning &&
    !warnedFallbackMessages.has(state.warning)
  ) {
    warnedFallbackMessages.add(state.warning);
    ctx.ui.notify(state.warning, "warning");
  }
}

function notifyWhimsicalStatus(
  ctx: ExtensionCommandContext,
  options: { refresh?: boolean } = {}
): void {
  if (options.refresh !== false) {
    applyResolvedState(
      resolveWhimsicalState(
        ctx.sessionManager.getEntries() as readonly SessionEntryLike[]
      ),
      ctx
    );
  }
  const fallbackSuffix =
    selectedSetSource === "fallback" ? ` (requested: ${requestedSet})` : "";
  ctx.ui.notify(
    `Whimsical message set: ${selectedSet} (${selectedSetSource}${fallbackSuffix}). Available: ${getAvailableMessageSetNames().join(", ")}`,
    "info"
  );
}

function persistSelectedSet(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  nextSelectedSet: string
): void {
  const state = { selectedSet: nextSelectedSet };
  writeWhimsicalConfigFile(state);
  pi.appendEntry(WHIMSICAL_CUSTOM_TYPE, state);
  applyResolvedState(resolveSelectedSet(state, "command"), ctx);
  notifyWhimsicalStatus(ctx, { refresh: false });
}

export default function whimsicalExtension(pi: ExtensionAPI): void {
  applyResolvedState(resolveWhimsicalState([]));

  function refreshRuntimeState(
    ctx: ExtensionContext,
    options: { refreshMessageSets?: boolean } = {}
  ): void {
    applyResolvedState(
      resolveWhimsicalState(
        ctx.sessionManager.getEntries() as readonly SessionEntryLike[],
        options
      ),
      ctx
    );
  }

  pi.on("session_start", (_event, ctx) => {
    refreshRuntimeState(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    refreshRuntimeState(ctx, { refreshMessageSets: false });
  });

  pi.on("turn_start", (_event, ctx) => {
    ctx.ui.setWorkingMessage(pickRandom());
  });

  pi.on("turn_end", (_event, ctx) => {
    ctx.ui.setWorkingMessage();
  });

  pi.registerCommand("whimsical", {
    description: "Select whimsical working messages: /whimsical [set]",
    getArgumentCompletions(argumentPrefix) {
      const prefix = argumentPrefix.trim().toLowerCase();
      return getAvailableMessageSetNames()
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: name, label: name }));
    },
    handler(args: string, ctx: ExtensionCommandContext) {
      const command = args.trim().toLowerCase().split(WHITESPACE_PATTERN)[0];

      if (!command) {
        notifyWhimsicalStatus(ctx);
        return Promise.resolve();
      }

      refreshMessageSets();
      const hasMessageSet = hasOwn(messageSets, command);
      const hasInvalidCustomSet = hasOwn(
        customMessageSets.invalidReasons,
        command
      );
      if (!(hasMessageSet || hasInvalidCustomSet)) {
        ctx.ui.notify(
          `Usage: /whimsical [${getAvailableMessageSetNames().join("|")}]`,
          "warning"
        );
        return Promise.resolve();
      }

      persistSelectedSet(pi, ctx, command);
      return Promise.resolve();
    },
  });
}
