import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  mergeFilePickerConfigs,
  normalizeFilePickerConfig,
} from "./file-picker-config.js";
import type { PickerConfig, PickerRuntimeConfig } from "./file-picker-types.js";

export type EditorEnhancementsConfig = {
  doubleEscapeCommand?: string | null;
  commandRemap?: Record<string, string>;
  filePicker?: PickerConfig;
};

export type EditorEnhancementsRuntimeConfig = {
  doubleEscapeCommand: string | null;
  commandRemap: Record<string, string>;
  filePicker: PickerRuntimeConfig;
};

type EditorEnhancementsConfigLayer = {
  doubleEscapeCommand?: string | null;
  commandRemap?: Record<string, string>;
  filePicker?: Partial<PickerRuntimeConfig>;
};

type LoadConfigOptions = {
  homeDir?: string;
  cwd?: string;
};

const DEFAULT_CONFIG: EditorEnhancementsRuntimeConfig = {
  doubleEscapeCommand: null,
  commandRemap: {},
  filePicker: mergeFilePickerConfigs(),
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
