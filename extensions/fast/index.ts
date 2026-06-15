import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const WHITESPACE_PATTERN = /\s+/;

export const FAST_MODE_CUSTOM_TYPE = "fast:mode";
export const FAST_MODE_STATUS_KEY = "fast";
export const FAST_MODE_STATUS_TEXT = "⚡ fast";
export const FAST_MODE_UNSUPPORTED_STATUS_TEXT = "⚡ fast*";
export const FAST_MODE_WARNING =
  "Fast mode enabled. It may use priority service tier and cost more.";

interface FastModeState {
  enabled: boolean;
  warned: boolean;
}

interface FastModeConfig extends FastModeState {
  allowlist: string[];
  extra: Record<string, unknown>;
}

interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

interface FastModel {
  fastMode?: boolean;
  id?: string;
  provider?: string;
}

const BUILT_IN_FAST_MODE_ALLOWLIST = ["openai-codex/gpt-5.5"] as const;
const FAST_MODE_ALLOWLIST: Set<string> = new Set(BUILT_IN_FAST_MODE_ALLOWLIST);
const CANONICAL_MODEL_ID_REGEX = /^[^/\s]+\/[^/\s]+$/;

type FastModeSupportSource =
  | "model"
  | "built-in allowlist"
  | "config allowlist"
  | "unsupported";

let configFastModeAllowlist = new Set<string>();

let fastModeEnabled = false;
let fastModeWarned = false;

export function isFastModeEnabled(): boolean {
  return fastModeEnabled;
}

function getCanonicalModelIds(model: FastModel | null): string[] {
  if (!model?.id) {
    return [];
  }

  const ids = new Set<string>();
  if (CANONICAL_MODEL_ID_REGEX.test(model.id)) {
    ids.add(model.id);
  }
  if (model.provider) {
    ids.add(`${model.provider}/${model.id}`);
  }

  return [...ids];
}

function getFastModeSupportSource(model: unknown): FastModeSupportSource {
  const candidate = model as FastModel | null;
  if (candidate?.fastMode === true) {
    return "model";
  }

  const modelIds = getCanonicalModelIds(candidate);
  if (modelIds.some((id) => FAST_MODE_ALLOWLIST.has(id))) {
    return "built-in allowlist";
  }
  if (modelIds.some((id) => configFastModeAllowlist.has(id))) {
    return "config allowlist";
  }

  return "unsupported";
}

export function modelSupportsFastMode(model: unknown): boolean {
  return getFastModeSupportSource(model) !== "unsupported";
}

function parseFastModeState(data: unknown): FastModeState | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const state = data as { enabled?: unknown; warned?: unknown };
  if (typeof state.enabled !== "boolean") {
    return null;
  }

  return {
    enabled: state.enabled,
    warned: typeof state.warned === "boolean" ? state.warned : false,
  };
}

function validateAllowlist(allowlist: unknown, configPath: string): string[] {
  if (!Array.isArray(allowlist)) {
    throw new Error(`Invalid Fast Mode allowlist in: ${configPath}`);
  }

  for (const item of allowlist) {
    if (typeof item !== "string" || !CANONICAL_MODEL_ID_REGEX.test(item)) {
      throw new Error(`Invalid Fast Mode allowlist entry in: ${configPath}`);
    }
  }

  return allowlist;
}

function parseFastModeConfig(
  data: unknown,
  configPath: string
): FastModeConfig {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Invalid Fast Mode config file: ${configPath}`);
  }

  const raw = data as Record<string, unknown>;
  if ("allowList" in raw) {
    throw new Error(
      `Invalid Fast Mode config key "allowList" in: ${configPath}`
    );
  }
  if (typeof raw.enabled !== "boolean") {
    throw new Error(`Invalid Fast Mode state file: ${configPath}`);
  }

  const { enabled, warned, allowlist, ...extra } = raw;
  return {
    enabled,
    warned: typeof warned === "boolean" ? warned : false,
    allowlist: validateAllowlist(allowlist, configPath),
    extra,
  };
}

function isFastModeEntry(
  entry: SessionEntryLike | undefined
): entry is SessionEntryLike {
  return entry?.type === "custom" && entry.customType === FAST_MODE_CUSTOM_TYPE;
}

function getLatestFastModeState(
  entries: readonly SessionEntryLike[]
): FastModeState | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isFastModeEntry(entry)) {
      continue;
    }

    const state = parseFastModeState(entry.data);
    if (state) {
      return state;
    }
  }

  return null;
}

function getGlobalFastModeConfigPath(homeDir = homedir()): string {
  return join(homeDir, ".pi", "agent", "fast-mode.json");
}

function loadFastModeConfigFile(configPath: string): FastModeState | null {
  if (!existsSync(configPath)) {
    configFastModeAllowlist = new Set();
    return null;
  }

  const config = parseFastModeConfig(
    JSON.parse(readFileSync(configPath, "utf8")),
    configPath
  );
  configFastModeAllowlist = new Set(config.allowlist);

  return { enabled: config.enabled, warned: config.warned };
}

function readFastModeConfigForWrite(configPath: string): FastModeConfig | null {
  if (!existsSync(configPath)) {
    return null;
  }

  return parseFastModeConfig(
    JSON.parse(readFileSync(configPath, "utf8")),
    configPath
  );
}

function writeFastModeConfigFile(
  state: FastModeState,
  homeDir = homedir()
): void {
  const configPath = getGlobalFastModeConfigPath(homeDir);
  const existingConfig = readFastModeConfigForWrite(configPath);
  const allowlist = existingConfig?.allowlist ?? [
    ...BUILT_IN_FAST_MODE_ALLOWLIST,
  ];
  const nextConfig = {
    ...(existingConfig?.extra ?? {}),
    enabled: state.enabled,
    warned: state.warned,
    allowlist,
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  configFastModeAllowlist = new Set(allowlist);
}

function resolveFastModeState(
  entries: readonly SessionEntryLike[],
  flagEnabled: boolean,
  homeDir = homedir()
): FastModeState {
  const configState = loadFastModeConfigFile(
    getGlobalFastModeConfigPath(homeDir)
  );
  if (flagEnabled) {
    return { enabled: true, warned: false };
  }

  return (
    getLatestFastModeState(entries) ??
    configState ?? {
      enabled: false,
      warned: false,
    }
  );
}

function refreshFastStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) {
    return;
  }

  let statusText: string | undefined;
  if (fastModeEnabled) {
    statusText = modelSupportsFastMode(ctx.model)
      ? FAST_MODE_STATUS_TEXT
      : FAST_MODE_UNSUPPORTED_STATUS_TEXT;
  }

  ctx.ui.setStatus(FAST_MODE_STATUS_KEY, statusText);
}

function notifyFastModeStatus(
  ctx: ExtensionCommandContext,
  enabled: boolean
): void {
  const supportSource = getFastModeSupportSource(ctx.model);
  const suffix = enabled ? ` (current model: ${supportSource})` : "";
  ctx.ui.notify(
    `Fast mode ${enabled ? "enabled" : "disabled"}${suffix}`,
    "info"
  );
}

function setEnabled(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  nextEnabled: boolean,
  persist: boolean,
  warned = fastModeWarned
): void {
  const state = { enabled: nextEnabled, warned };
  if (persist) {
    writeFastModeConfigFile(state);
    pi.appendEntry(FAST_MODE_CUSTOM_TYPE, state);
  }

  fastModeEnabled = nextEnabled;
  fastModeWarned = warned;
  refreshFastStatus(ctx);
}

function persistFastModeCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  nextEnabled: boolean
): void {
  const shouldWarn = nextEnabled && !fastModeWarned;
  setEnabled(pi, ctx, nextEnabled, true, fastModeWarned || shouldWarn);
  if (shouldWarn) {
    ctx.ui.notify(FAST_MODE_WARNING, "warning");
  }
  notifyFastModeStatus(ctx, nextEnabled);
}

export function applyFastModeToPayload(
  payload: unknown,
  enabled: boolean,
  model: unknown
): unknown | undefined {
  if (!(enabled && modelSupportsFastMode(model))) {
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return;
  }
  if ("service_tier" in payload || "serviceTier" in payload) {
    return;
  }

  return { ...payload, service_tier: "priority" };
}

export function registerFastMode(pi: ExtensionAPI): void {
  pi.registerFlag("fast", {
    description: "Enable fast mode when the selected model supports it",
    type: "boolean",
    default: false,
  });

  const initialState = resolveFastModeState([], Boolean(pi.getFlag("fast")));
  fastModeEnabled = initialState.enabled;
  fastModeWarned = initialState.warned;

  function refreshRuntimeState(ctx: ExtensionContext): void {
    const fastFlagEnabled = Boolean(pi.getFlag("fast"));
    const state = resolveFastModeState(
      ctx.sessionManager.getEntries() as readonly SessionEntryLike[],
      fastFlagEnabled
    );
    setEnabled(pi, ctx, state.enabled, fastFlagEnabled, state.warned);
  }

  pi.on("session_start", (_event, ctx) => {
    refreshRuntimeState(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    refreshRuntimeState(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    refreshFastStatus(ctx);
  });

  pi.on("before_provider_request", (event, ctx) =>
    applyFastModeToPayload(event.payload, fastModeEnabled, ctx.model)
  );

  pi.registerCommand("fast", {
    description: "Fast mode: /fast [on|off|status]",
    getArgumentCompletions(argumentPrefix) {
      const prefix = argumentPrefix.trim().toLowerCase();
      return ["on", "off", "status"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler(args: string, ctx: ExtensionCommandContext) {
      const command = args.trim().toLowerCase().split(WHITESPACE_PATTERN)[0];

      if (!command) {
        persistFastModeCommand(pi, ctx, !fastModeEnabled);
        return Promise.resolve();
      }

      switch (command) {
        case "on":
          persistFastModeCommand(pi, ctx, true);
          return Promise.resolve();
        case "off":
          persistFastModeCommand(pi, ctx, false);
          return Promise.resolve();
        case "status":
          refreshFastStatus(ctx);
          notifyFastModeStatus(ctx, fastModeEnabled);
          return Promise.resolve();
        default:
          ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
          return Promise.resolve();
      }
    },
  });
}

export default function fastModeExtension(pi: ExtensionAPI): void {
  registerFastMode(pi);
}
