import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  PickerConfig,
  PickerRuntimeConfig,
} from "../file-picker/types.js";
import { mergeStatusBarSegmentOptions } from "../status-bar/config-utils.js";
import {
  type ColorScheme,
  STATUS_BAR_SEGMENT_IDS,
  STATUS_BAR_SEMANTIC_COLORS,
  type StatusBarPreset,
  type StatusBarSegmentId,
  type StatusBarSegmentOptions,
} from "../status-bar/types.js";
import {
  mergeFilePickerConfigs,
  normalizeFilePickerConfig,
} from "./file-picker.js";
import {
  type FixedEditorConfig,
  type FixedEditorRuntimeConfig,
  mergeFixedEditorConfigs,
  normalizeFixedEditorConfig,
} from "./fixed-editor.js";

export * from "./fixed-editor.js";

export interface StatusBarConfig {
  enabled?: boolean;
  preset?: StatusBarPreset;
  leftSegments?: StatusBarSegmentId[];
  rightSegments?: StatusBarSegmentId[];
  separator?: string;
  colors?: ColorScheme;
  segmentOptions?: StatusBarSegmentOptions;
}

export interface StatusBarRuntimeConfig {
  enabled: boolean;
  preset: StatusBarPreset;
  leftSegments?: StatusBarSegmentId[];
  rightSegments?: StatusBarSegmentId[];
  separator?: string;
  colors?: ColorScheme;
  segmentOptions?: StatusBarSegmentOptions;
}

export interface EditorEnhancementsConfig {
  doubleEscapeCommand?: string | null;
  commandRemap?: Record<string, string>;
  filePicker?: PickerConfig;
  statusBar?: StatusBarConfig;
  fixedEditor?: FixedEditorConfig;
}

export interface EditorEnhancementsRuntimeConfig {
  doubleEscapeCommand: string | null;
  commandRemap: Record<string, string>;
  filePicker: PickerRuntimeConfig;
  statusBar: StatusBarRuntimeConfig;
  fixedEditor: FixedEditorRuntimeConfig;
}

interface EditorEnhancementsConfigLayer {
  doubleEscapeCommand?: string | null;
  commandRemap?: Record<string, string>;
  filePicker?: Partial<PickerRuntimeConfig>;
  statusBar?: Partial<StatusBarRuntimeConfig>;
  fixedEditor?: Partial<FixedEditorRuntimeConfig>;
}

interface LoadConfigOptions {
  homeDir?: string;
  cwd?: string;
}

const DEFAULT_CONFIG: EditorEnhancementsRuntimeConfig = {
  doubleEscapeCommand: null,
  commandRemap: {},
  filePicker: mergeFilePickerConfigs(),
  statusBar: {
    enabled: true,
    preset: "default",
  },
  fixedEditor: mergeFixedEditorConfigs(),
};

export function normalizeCommandName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  return normalized || null;
}

export function normalizeCommandRemap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

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

const STATUS_BAR_SEGMENT_ID_SET = new Set<string>(STATUS_BAR_SEGMENT_IDS);
const STATUS_BAR_SEMANTIC_COLOR_SET = new Set<string>(
  STATUS_BAR_SEMANTIC_COLORS
);

function normalizeStatusBarSegments(
  value: unknown
): StatusBarSegmentId[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter(
    (entry): entry is StatusBarSegmentId =>
      typeof entry === "string" && STATUS_BAR_SEGMENT_ID_SET.has(entry)
  );
}

function normalizeStatusBarSeparator(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeStatusBarColors(value: unknown): ColorScheme | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const next: ColorScheme = {};

  for (const [key, candidate] of Object.entries(raw)) {
    if (
      !STATUS_BAR_SEMANTIC_COLOR_SET.has(key) ||
      typeof candidate !== "string"
    ) {
      continue;
    }

    const color = candidate.trim();
    if (!color) {
      continue;
    }

    next[key as keyof ColorScheme] = color as ColorScheme[keyof ColorScheme];
  }

  return Object.keys(next).length > 0 ? next : null;
}

function normalizeStatusBarSegmentOptions(
  value: unknown
): StatusBarSegmentOptions | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const next: StatusBarSegmentOptions = {};

  if (raw.model && typeof raw.model === "object" && !Array.isArray(raw.model)) {
    const model = raw.model as Record<string, unknown>;
    if (typeof model.showThinkingLevel === "boolean") {
      next.model = { showThinkingLevel: model.showThinkingLevel };
    }
  }

  if (raw.path && typeof raw.path === "object" && !Array.isArray(raw.path)) {
    const path = raw.path as Record<string, unknown>;
    const pathOptions: NonNullable<StatusBarSegmentOptions["path"]> = {};

    if (
      path.mode === "basename" ||
      path.mode === "abbreviated" ||
      path.mode === "full"
    ) {
      pathOptions.mode = path.mode;
    }

    if (
      typeof path.maxLength === "number" &&
      Number.isFinite(path.maxLength) &&
      path.maxLength > 0
    ) {
      pathOptions.maxLength = Math.floor(path.maxLength);
    }

    if (Object.keys(pathOptions).length > 0) {
      next.path = pathOptions;
    }
  }

  if (raw.git && typeof raw.git === "object" && !Array.isArray(raw.git)) {
    const git = raw.git as Record<string, unknown>;
    const gitOptions: NonNullable<StatusBarSegmentOptions["git"]> = {};

    if (typeof git.showBranch === "boolean") {
      gitOptions.showBranch = git.showBranch;
    }
    if (typeof git.showStaged === "boolean") {
      gitOptions.showStaged = git.showStaged;
    }
    if (typeof git.showUnstaged === "boolean") {
      gitOptions.showUnstaged = git.showUnstaged;
    }
    if (typeof git.showUntracked === "boolean") {
      gitOptions.showUntracked = git.showUntracked;
    }

    if (Object.keys(gitOptions).length > 0) {
      next.git = gitOptions;
    }
  }

  if (raw.time && typeof raw.time === "object" && !Array.isArray(raw.time)) {
    const time = raw.time as Record<string, unknown>;
    const timeOptions: NonNullable<StatusBarSegmentOptions["time"]> = {};

    if (time.format === "12h" || time.format === "24h") {
      timeOptions.format = time.format;
    }

    if (typeof time.showSeconds === "boolean") {
      timeOptions.showSeconds = time.showSeconds;
    }

    if (Object.keys(timeOptions).length > 0) {
      next.time = timeOptions;
    }
  }

  return Object.keys(next).length > 0 ? next : null;
}

function mergeStatusBarColors(
  base?: ColorScheme,
  override?: ColorScheme
): ColorScheme | undefined {
  const merged = { ...base, ...override };
  return Object.keys(merged).length > 0 ? merged : undefined;
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

  if (Object.hasOwn(raw, "leftSegments")) {
    const leftSegments = normalizeStatusBarSegments(raw.leftSegments);
    if (leftSegments) {
      next.leftSegments = leftSegments;
    }
  }

  if (Object.hasOwn(raw, "rightSegments")) {
    const rightSegments = normalizeStatusBarSegments(raw.rightSegments);
    if (rightSegments) {
      next.rightSegments = rightSegments;
    }
  }

  if (Object.hasOwn(raw, "separator")) {
    const separator = normalizeStatusBarSeparator(raw.separator);
    if (separator !== null) {
      next.separator = separator;
    }
  }

  if (Object.hasOwn(raw, "colors")) {
    const colors = normalizeStatusBarColors(raw.colors);
    if (colors) {
      next.colors = colors;
    }
  }

  if (Object.hasOwn(raw, "segmentOptions")) {
    const segmentOptions = normalizeStatusBarSegmentOptions(raw.segmentOptions);
    if (segmentOptions) {
      next.segmentOptions = segmentOptions;
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function loadConfigFile(
  configPath: string
): EditorEnhancementsConfigLayer | null {
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      readFileSync(configPath, "utf-8")
    ) as EditorEnhancementsConfig;
    const next: EditorEnhancementsConfigLayer = {};

    if (Object.hasOwn(parsed, "doubleEscapeCommand")) {
      next.doubleEscapeCommand = normalizeCommandName(
        parsed.doubleEscapeCommand
      );
    }

    if (Object.hasOwn(parsed, "commandRemap")) {
      next.commandRemap = normalizeCommandRemap(parsed.commandRemap);
    }

    if (Object.hasOwn(parsed, "filePicker")) {
      next.filePicker = normalizeFilePickerConfig(parsed.filePicker);
    }

    if (Object.hasOwn(parsed, "statusBar")) {
      next.statusBar = normalizeStatusBarConfig(parsed.statusBar);
    }

    if (Object.hasOwn(parsed, "fixedEditor")) {
      next.fixedEditor = normalizeFixedEditorConfig(parsed.fixedEditor);
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
      leftSegments:
        projectConfig?.statusBar?.leftSegments ??
        globalConfig?.statusBar?.leftSegments,
      rightSegments:
        projectConfig?.statusBar?.rightSegments ??
        globalConfig?.statusBar?.rightSegments,
      separator:
        projectConfig?.statusBar?.separator ??
        globalConfig?.statusBar?.separator,
      colors: mergeStatusBarColors(
        globalConfig?.statusBar?.colors,
        projectConfig?.statusBar?.colors
      ),
      segmentOptions: mergeStatusBarSegmentOptions(
        globalConfig?.statusBar?.segmentOptions,
        projectConfig?.statusBar?.segmentOptions
      ),
    },
    fixedEditor: mergeFixedEditorConfigs(
      DEFAULT_CONFIG.fixedEditor,
      globalConfig?.fixedEditor,
      projectConfig?.fixedEditor
    ),
  };
}

function getHomeDir(): string {
  return process.env.HOME ?? homedir();
}

export function getGlobalPieditorConfigPath(homeDir = getHomeDir()): string {
  return join(homeDir, ".pi", "agent", "pieditor.json");
}

export function getProjectPieditorConfigPath(cwd = process.cwd()): string {
  return join(cwd, ".pi", "pieditor.json");
}

type PersistFixedEditorEnabledResult =
  | { ok: true; configPath: string; config: EditorEnhancementsRuntimeConfig }
  | { ok: false; configPath: string; error: string };

function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readConfigObjectForPersistence(
  configPath: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!existsSync(configPath)) {
    return { ok: true, value: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid JSON in ${configPath}: ${message}` };
  }

  if (!isPlainConfigObject(parsed)) {
    return { ok: false, error: `${configPath} must contain a JSON object` };
  }

  return { ok: true, value: parsed };
}

function writeConfigObjectAtomically(
  configPath: string,
  value: Record<string, unknown>
): void {
  const tempPath = `${configPath}.${randomBytes(8).toString("hex")}.tmp`;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(tempPath, configPath);
}

export function saveGlobalFixedEditorEnabled(
  enabled: boolean,
  options: Pick<LoadConfigOptions, "homeDir" | "cwd"> = {}
): PersistFixedEditorEnabledResult {
  const homeDir = options.homeDir ?? getHomeDir();
  const cwd = options.cwd ?? process.cwd();
  const configPath = getGlobalPieditorConfigPath(homeDir);
  const current = readConfigObjectForPersistence(configPath);

  if (!current.ok) {
    return { ok: false, configPath, error: current.error };
  }

  const fixedEditor = isPlainConfigObject(current.value.fixedEditor)
    ? current.value.fixedEditor
    : {};
  const next = {
    ...current.value,
    fixedEditor: {
      ...fixedEditor,
      enabled,
    },
  };

  try {
    writeConfigObjectAtomically(configPath, next);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, configPath, error: message };
  }

  return { ok: true, configPath, config: loadConfig({ homeDir, cwd }) };
}

export function hasProjectFixedEditorEnabledOverride(
  options: Pick<LoadConfigOptions, "cwd"> = {}
): boolean {
  const configPath = getProjectPieditorConfigPath(options.cwd ?? process.cwd());
  const current = readConfigObjectForPersistence(configPath);

  if (!current.ok) {
    return false;
  }

  return (
    isPlainConfigObject(current.value.fixedEditor) &&
    Object.hasOwn(current.value.fixedEditor, "enabled")
  );
}

export function loadConfig(
  options: LoadConfigOptions = {}
): EditorEnhancementsRuntimeConfig {
  const homeDir = options.homeDir ?? getHomeDir();
  const cwd = options.cwd ?? process.cwd();
  const globalConfig = loadConfigFile(getGlobalPieditorConfigPath(homeDir));
  const projectConfig = loadConfigFile(getProjectPieditorConfigPath(cwd));

  return resolveRuntimeConfig(globalConfig, projectConfig);
}
