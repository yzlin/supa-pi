import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  mergeFilePickerConfigs,
  normalizeFilePickerConfig,
} from "./file-picker-config.js";
import type { PickerConfig, PickerRuntimeConfig } from "./file-picker-types.js";
import type { StatusBarPreset } from "./status-bar-types.js";

export type StatusBarConfig = {
  enabled?: boolean;
  preset?: StatusBarPreset;
};

export type StatusBarRuntimeConfig = {
  enabled: boolean;
  preset: StatusBarPreset;
};

export type EditorEnhancementsConfig = {
  doubleEscapeCommand?: string | null;
  commandRemap?: Record<string, string>;
  filePicker?: PickerConfig;
  statusBar?: StatusBarConfig;
};

export type EditorEnhancementsRuntimeConfig = {
  doubleEscapeCommand: string | null;
  commandRemap: Record<string, string>;
  filePicker: PickerRuntimeConfig;
  statusBar: StatusBarRuntimeConfig;
};

type EditorEnhancementsConfigLayer = {
  doubleEscapeCommand?: string | null;
  commandRemap?: Record<string, string>;
  filePicker?: Partial<PickerRuntimeConfig>;
  statusBar?: Partial<StatusBarRuntimeConfig>;
};

type LoadConfigOptions = {
  homeDir?: string;
  cwd?: string;
};

const DEFAULT_CONFIG: EditorEnhancementsRuntimeConfig = {
  doubleEscapeCommand: null,
  commandRemap: {},
  filePicker: mergeFilePickerConfigs(),
  statusBar: {
    enabled: true,
    preset: "default",
  },
};

export function normalizeCommandName(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  return normalized || null;
}

export function normalizeCommandRemap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const result: Record<string, string> = {};
  for (const [from, to] of Object.entries(value as Record<string, unknown>)) {
    const normalizedFrom = normalizeCommandName(from);
    const normalizedTo = normalizeCommandName(to);
    if (normalizedFrom && normalizedTo) {
      result[normalizedFrom] = normalizedTo;
    }
  }
  return result;
}

function normalizeStatusBarPreset(value: unknown): StatusBarPreset | null {
  switch (value) {
    case "default":
    case "minimal":
    case "compact":
    case "full":
    case "nerd":
    case "ascii":
      return value;
    default:
      return null;
  }
}

function normalizeStatusBarConfig(
  value: unknown
): Partial<StatusBarRuntimeConfig> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const next: Partial<StatusBarRuntimeConfig> = {};

  if (typeof raw.enabled === "boolean") {
    next.enabled = raw.enabled;
  }

  const preset = normalizeStatusBarPreset(raw.preset);
  if (preset) {
    next.preset = preset;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function loadConfigFile(
  configPath: string
): EditorEnhancementsConfigLayer | null {
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(configPath, "utf-8")
    ) as EditorEnhancementsConfig;
    const next: EditorEnhancementsConfigLayer = {};

    if (Object.prototype.hasOwnProperty.call(parsed, "doubleEscapeCommand")) {
      next.doubleEscapeCommand = normalizeCommandName(
        parsed.doubleEscapeCommand
      );
    }

    if (Object.prototype.hasOwnProperty.call(parsed, "commandRemap")) {
      next.commandRemap = normalizeCommandRemap(parsed.commandRemap);
    }

    if (Object.prototype.hasOwnProperty.call(parsed, "filePicker")) {
      next.filePicker = normalizeFilePickerConfig(parsed.filePicker);
    }

    if (Object.prototype.hasOwnProperty.call(parsed, "statusBar")) {
      next.statusBar = normalizeStatusBarConfig(parsed.statusBar);
    }

    return next;
  } catch {
    return null;
  }
}

export function resolveRuntimeConfig(
  globalConfig: EditorEnhancementsConfigLayer | null,
  projectConfig: EditorEnhancementsConfigLayer | null
): EditorEnhancementsRuntimeConfig {
  return {
    doubleEscapeCommand:
      projectConfig?.doubleEscapeCommand ??
      globalConfig?.doubleEscapeCommand ??
      DEFAULT_CONFIG.doubleEscapeCommand,
    commandRemap: {
      ...DEFAULT_CONFIG.commandRemap,
      ...globalConfig?.commandRemap,
      ...projectConfig?.commandRemap,
    },
    filePicker: mergeFilePickerConfigs(
      DEFAULT_CONFIG.filePicker,
      globalConfig?.filePicker,
      projectConfig?.filePicker
    ),
    statusBar: {
      enabled:
        projectConfig?.statusBar?.enabled ??
        globalConfig?.statusBar?.enabled ??
        DEFAULT_CONFIG.statusBar.enabled,
      preset:
        projectConfig?.statusBar?.preset ??
        globalConfig?.statusBar?.preset ??
        DEFAULT_CONFIG.statusBar.preset,
    },
  };
}

export function loadConfig(
  options: LoadConfigOptions = {}
): EditorEnhancementsRuntimeConfig {
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const globalConfig = loadConfigFile(
    path.join(homeDir, ".pi", "agent", "editor-enhancements.json")
  );
  const projectConfig = loadConfigFile(
    path.join(cwd, ".pi", "editor-enhancements.json")
  );

  return resolveRuntimeConfig(globalConfig, projectConfig);
}
