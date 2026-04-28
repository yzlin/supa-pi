import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  BeforeAgentStartEvent,
  EventBus,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

export const CAVEMAN_MODE_CUSTOM_TYPE = "caveman:mode";
export const LEGACY_CAVEMAN_MODE_CUSTOM_TYPE = "pieditor:caveman-mode";
export const CAVEMAN_MODE_STATUS_KEY = "caveman";
export const CAVEMAN_MODE_STATUS_TEXT = "🪨 caveman";
export const CAVEMAN_RPC_VERSION = 1;
export const CAVEMAN_RPC_CAPABILITIES_CHANNEL = "caveman:rpc:capabilities";
export const CAVEMAN_RPC_APPLY_CHANNEL = "caveman:rpc:apply";

export const CAVEMAN_MODE_PROMPT = `CAVEMAN MODE ACTIVE:
- Answer user in short caveman-style phrases.
- Keep code, commands, paths, JSON, and tool arguments exact; do not caveman-translate them.
- Still follow all higher-priority instructions and complete the task normally.`;

interface CavemanModeState {
  enabled: boolean;
}

interface CavemanRpcCapabilitiesData {
  version: 1;
  supportsApply: true;
}

interface CavemanRpcApplyData {
  version: 1;
  systemPrompt: string;
}

type CavemanRpcResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string };

let cavemanModeEnabled = false;

export function isCavemanModeEnabled(): boolean {
  return cavemanModeEnabled;
}

interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

const CAVEMAN_MODE_COMPLETIONS = [
  {
    value: "on",
    label: "on",
    description: "Enable caveman mode",
  },
  {
    value: "off",
    label: "off",
    description: "Disable caveman mode",
  },
  {
    value: "status",
    label: "status",
    description: "Show caveman mode status",
  },
  {
    value: "toggle",
    label: "toggle",
    description: "Toggle caveman mode",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stripCavemanPrompt(systemPrompt: string): string {
  if (!systemPrompt.includes(CAVEMAN_MODE_PROMPT)) {
    return systemPrompt;
  }

  return systemPrompt
    .split(CAVEMAN_MODE_PROMPT)
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function applyCavemanPrompt(
  systemPrompt: string,
  enabled: boolean
): string {
  const strippedPrompt = stripCavemanPrompt(systemPrompt);

  if (!enabled) {
    return strippedPrompt;
  }

  return strippedPrompt
    ? `${strippedPrompt}\n\n${CAVEMAN_MODE_PROMPT}`
    : CAVEMAN_MODE_PROMPT;
}

function parseCavemanModeState(data: unknown): CavemanModeState | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const state = data as { enabled?: unknown };
  if (typeof state.enabled !== "boolean") {
    return null;
  }

  return { enabled: state.enabled };
}

function isCavemanModeEntry(
  entry: SessionEntryLike | undefined
): entry is SessionEntryLike {
  return (
    entry?.type === "custom" &&
    (entry.customType === CAVEMAN_MODE_CUSTOM_TYPE ||
      entry.customType === LEGACY_CAVEMAN_MODE_CUSTOM_TYPE)
  );
}

function getLatestCavemanModeState(
  entries: readonly SessionEntryLike[]
): CavemanModeState | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isCavemanModeEntry(entry)) {
      continue;
    }

    const state = parseCavemanModeState(entry.data);
    if (state) {
      return state;
    }
  }

  return null;
}

function getGlobalCavemanConfigPath(homeDir = homedir()): string {
  return join(homeDir, ".pi", "agent", "caveman.json");
}

function getProjectCavemanConfigPath(cwd = process.cwd()): string {
  return join(cwd, ".pi", "caveman.json");
}

function loadCavemanConfigFile(configPath: string): CavemanModeState | null {
  try {
    return parseCavemanModeState(JSON.parse(readFileSync(configPath, "utf8")));
  } catch {
    return null;
  }
}

function getConfigCavemanModeState(
  cwd = process.cwd(),
  homeDir = homedir()
): CavemanModeState | null {
  return (
    loadCavemanConfigFile(getProjectCavemanConfigPath(cwd)) ??
    loadCavemanConfigFile(getGlobalCavemanConfigPath(homeDir))
  );
}

function resolveCavemanModeState(
  entries: readonly SessionEntryLike[],
  cwd = process.cwd(),
  homeDir = homedir()
): CavemanModeState {
  return (
    getLatestCavemanModeState(entries) ??
    getConfigCavemanModeState(cwd, homeDir) ?? { enabled: false }
  );
}

function refreshCavemanStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) {
    return;
  }

  ctx.ui.setStatus(
    CAVEMAN_MODE_STATUS_KEY,
    cavemanModeEnabled ? CAVEMAN_MODE_STATUS_TEXT : undefined
  );
}

function describeCavemanModeStatus(enabled: boolean): string {
  return `Caveman mode ${enabled ? "enabled" : "disabled"}`;
}

function notifyCavemanModeStatus(
  ctx: ExtensionCommandContext,
  enabled: boolean
): void {
  ctx.ui.notify(describeCavemanModeStatus(enabled), "info");
}

function createCavemanCapabilitiesResponse(): CavemanRpcResponse<CavemanRpcCapabilitiesData> {
  return {
    success: true,
    data: { version: CAVEMAN_RPC_VERSION, supportsApply: true },
  };
}

function applyCavemanRpcRequest(
  payload: unknown
): CavemanRpcResponse<CavemanRpcApplyData> {
  if (!isRecord(payload)) {
    return { success: false, error: "Expected object payload" };
  }

  if (!isNonEmptyString(payload.requestId)) {
    return { success: false, error: "Expected non-empty requestId" };
  }

  if (payload.version !== CAVEMAN_RPC_VERSION) {
    return { success: false, error: "Unsupported caveman RPC version" };
  }

  if (typeof payload.enabled !== "boolean") {
    return { success: false, error: "Expected enabled boolean" };
  }

  if (typeof payload.systemPrompt !== "string") {
    return { success: false, error: "Expected systemPrompt string" };
  }

  return {
    success: true,
    data: {
      version: CAVEMAN_RPC_VERSION,
      systemPrompt: applyCavemanPrompt(payload.systemPrompt, payload.enabled),
    },
  };
}

function publishRpcResponse<T>(
  events: EventBus,
  channel: string,
  payload: unknown,
  response: CavemanRpcResponse<T>
): void {
  if (!isRecord(payload)) {
    return;
  }

  if (typeof payload.respond === "function") {
    payload.respond(response);
    return;
  }

  if (isNonEmptyString(payload.replyTo)) {
    events.emit(payload.replyTo, response);
    return;
  }

  if (isNonEmptyString(payload.requestId)) {
    events.emit(`${channel}:response:${payload.requestId}`, response);
    return;
  }

  events.emit(`${channel}:response`, response);
}

function registerCavemanRpc(pi: ExtensionAPI): void {
  const handleCapabilities = (
    payload: unknown
  ): CavemanRpcResponse<CavemanRpcCapabilitiesData> => {
    const response = createCavemanCapabilitiesResponse();
    publishRpcResponse(
      pi.events,
      CAVEMAN_RPC_CAPABILITIES_CHANNEL,
      payload,
      response
    );
    return response;
  };

  const handleApply = (
    payload: unknown
  ): CavemanRpcResponse<CavemanRpcApplyData> => {
    const response = applyCavemanRpcRequest(payload);
    publishRpcResponse(pi.events, CAVEMAN_RPC_APPLY_CHANNEL, payload, response);
    return response;
  };

  pi.events.on(CAVEMAN_RPC_CAPABILITIES_CHANNEL, handleCapabilities);
  pi.events.on(CAVEMAN_RPC_APPLY_CHANNEL, handleApply);
}

export function registerCavemanMode(pi: ExtensionAPI): void {
  cavemanModeEnabled = resolveCavemanModeState([]).enabled;
  registerCavemanRpc(pi);

  function setEnabled(
    ctx: ExtensionContext,
    nextEnabled: boolean,
    persist: boolean
  ): void {
    cavemanModeEnabled = nextEnabled;

    if (persist) {
      pi.appendEntry(CAVEMAN_MODE_CUSTOM_TYPE, {
        enabled: nextEnabled,
      });
    }

    refreshCavemanStatus(ctx);
  }

  function refreshRuntimeState(ctx: ExtensionContext): void {
    const state = resolveCavemanModeState(
      ctx.sessionManager.getEntries() as readonly SessionEntryLike[],
      ctx.cwd
    );
    setEnabled(ctx, state.enabled, false);
  }

  pi.on("session_start", (_event, ctx) => {
    refreshRuntimeState(ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    refreshRuntimeState(ctx);
  });

  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    if (!cavemanModeEnabled) {
      return undefined;
    }

    const systemPrompt = applyCavemanPrompt(event.systemPrompt, true);

    if (systemPrompt === event.systemPrompt) {
      return undefined;
    }

    return { systemPrompt };
  });

  pi.registerCommand("caveman", {
    description: "Toggle caveman mode: /caveman [on|off|status]",
    getArgumentCompletions(argumentPrefix) {
      const prefix = argumentPrefix.trim().toLowerCase();
      return CAVEMAN_MODE_COMPLETIONS.filter((completion) =>
        completion.value.startsWith(prefix)
      );
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = args.trim().toLowerCase().split(/\s+/)[0] || "toggle";

      switch (command) {
        case "on": {
          setEnabled(ctx, true, true);
          notifyCavemanModeStatus(ctx, true);
          return;
        }

        case "off": {
          setEnabled(ctx, false, true);
          notifyCavemanModeStatus(ctx, false);
          return;
        }

        case "status": {
          refreshCavemanStatus(ctx);
          notifyCavemanModeStatus(ctx, cavemanModeEnabled);
          return;
        }

        case "toggle": {
          const nextEnabled = !cavemanModeEnabled;
          setEnabled(ctx, nextEnabled, true);
          notifyCavemanModeStatus(ctx, nextEnabled);
          return;
        }

        default: {
          ctx.ui.notify("Usage: /caveman [on|off|status]", "warning");
        }
      }
    },
  });
}
