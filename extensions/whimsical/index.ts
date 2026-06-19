/*
 * Adapted from `agent-stuff` by original author Armin Ronacher (mitsuhiko).
 * Source: https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/whimsical.ts
 * Original license: Apache License 2.0.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const MESSAGE_SET_LIST = MESSAGE_SET_NAMES.join(", ");
const MESSAGE_SET_USAGE = MESSAGE_SET_NAMES.join("|");
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const WHITESPACE_PATTERN = /\s+/;

type MessageSetName = (typeof MESSAGE_SET_NAMES)[number];
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
  selectedSet: MessageSetName;
  requestedSet: string;
  source: SelectionSource;
}

let selectedSet: MessageSetName = DEFAULT_SET_NAME;
let selectedSetSource: SelectionSource = "default";
let requestedSet = DEFAULT_SET_NAME;
let warnedMissingSet = false;

export function validateMessageSet(name: string, data: unknown): string[] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(
      `Invalid whimsical message set "${name}": expected non-empty string array`
    );
  }

  for (const message of data) {
    if (typeof message !== "string" || message.length === 0) {
      throw new Error(
        `Invalid whimsical message set "${name}": expected non-empty strings`
      );
    }
  }

  return data;
}

function loadBundledMessageSet(name: MessageSetName): string[] {
  const path = join(MODULE_DIR, "messages", `${name}.json`);
  return validateMessageSet(name, JSON.parse(readFileSync(path, "utf8")));
}

const messageSets: Record<MessageSetName, string[]> = {
  default: loadBundledMessageSet("default"),
  "negative-energy": loadBundledMessageSet("negative-energy"),
};

function isMessageSetName(value: string): value is MessageSetName {
  return MESSAGE_SET_NAMES.includes(value as MessageSetName);
}

function pickRandom(): string {
  const messages = messageSets[selectedSet];
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

  if (isMessageSetName(state.selectedSet)) {
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
  };
}

function resolveWhimsicalState(
  entries: readonly SessionEntryLike[]
): ResolvedWhimsicalState {
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

  if (ctx && state.source === "fallback" && !warnedMissingSet) {
    warnedMissingSet = true;
    ctx.ui.notify(
      `Whimsical message set "${state.requestedSet}" is unavailable; using default.`,
      "warning"
    );
  }
}

function notifyWhimsicalStatus(ctx: ExtensionCommandContext): void {
  const fallbackSuffix =
    selectedSetSource === "fallback" ? ` (requested: ${requestedSet})` : "";
  ctx.ui.notify(
    `Whimsical message set: ${selectedSet} (${selectedSetSource}${fallbackSuffix}). Available: ${MESSAGE_SET_LIST}`,
    "info"
  );
}

function persistSelectedSet(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  nextSelectedSet: MessageSetName
): void {
  const state = { selectedSet: nextSelectedSet };
  writeWhimsicalConfigFile(state);
  pi.appendEntry(WHIMSICAL_CUSTOM_TYPE, state);
  applyResolvedState(resolveSelectedSet(state, "command"), ctx);
  notifyWhimsicalStatus(ctx);
}

export default function whimsicalExtension(pi: ExtensionAPI): void {
  applyResolvedState(resolveWhimsicalState([]));

  function refreshRuntimeState(ctx: ExtensionContext): void {
    applyResolvedState(
      resolveWhimsicalState(
        ctx.sessionManager.getEntries() as readonly SessionEntryLike[]
      ),
      ctx
    );
  }

  pi.on("session_start", (_event, ctx) => {
    refreshRuntimeState(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    refreshRuntimeState(ctx);
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
      return MESSAGE_SET_NAMES.filter((name) => name.startsWith(prefix)).map(
        (name) => ({ value: name, label: name })
      );
    },
    handler(args: string, ctx: ExtensionCommandContext) {
      const command = args.trim().toLowerCase().split(WHITESPACE_PATTERN)[0];

      if (!command) {
        notifyWhimsicalStatus(ctx);
        return Promise.resolve();
      }

      if (!isMessageSetName(command)) {
        ctx.ui.notify(`Usage: /whimsical [${MESSAGE_SET_USAGE}]`, "warning");
        return Promise.resolve();
      }

      persistSelectedSet(pi, ctx, command);
      return Promise.resolve();
    },
  });
}
