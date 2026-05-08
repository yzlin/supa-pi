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

export type ToolDisplayToolName = "read" | "search" | "edit" | "write";
export type ToolDisplayOutputMode = "compact" | "expanded";
export type ToolDisplayPresetName = "compact" | "verbose" | "off";

export interface ToolDisplayToolConfig {
  enabled: boolean;
}

export interface ToolDisplayReadConfig extends ToolDisplayToolConfig {
  fullSkillRead: boolean;
}

export interface ToolDisplayPreviewConfig {
  mode: ToolDisplayOutputMode;
  collapsed: boolean;
  previewLines: number;
}

export interface ToolDisplayBashOutputConfig extends ToolDisplayPreviewConfig {
  rtkHints: boolean;
}

export interface ToolDisplayDiffConfig {
  enabled: boolean;
  collapsed: boolean;
  previewLines: number;
}

export interface ToolDisplayConfig {
  tools: {
    read: ToolDisplayReadConfig;
    search: ToolDisplayToolConfig;
    edit: ToolDisplayToolConfig;
    write: ToolDisplayToolConfig;
  };
  output: {
    read: ToolDisplayPreviewConfig;
    search: ToolDisplayPreviewConfig;
    bash: ToolDisplayBashOutputConfig;
  };
  diff: ToolDisplayDiffConfig;
}

interface ToolDisplayConfigLayer {
  tools?: {
    read?: Partial<ToolDisplayReadConfig>;
    search?: Partial<ToolDisplayToolConfig>;
    edit?: Partial<ToolDisplayToolConfig>;
    write?: Partial<ToolDisplayToolConfig>;
  };
  output?: {
    read?: Partial<ToolDisplayPreviewConfig>;
    search?: Partial<ToolDisplayPreviewConfig>;
    bash?: Partial<ToolDisplayBashOutputConfig>;
  };
  diff?: Partial<ToolDisplayDiffConfig>;
}

export const DEFAULT_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
  tools: {
    read: {
      enabled: true,
      fullSkillRead: true,
    },
    search: {
      enabled: true,
    },
    edit: {
      enabled: true,
    },
    write: {
      enabled: true,
    },
  },
  output: {
    read: {
      mode: "compact",
      collapsed: true,
      previewLines: 20,
    },
    search: {
      mode: "compact",
      collapsed: true,
      previewLines: 20,
    },
    bash: {
      mode: "compact",
      collapsed: true,
      previewLines: 20,
      rtkHints: true,
    },
  },
  diff: {
    enabled: true,
    collapsed: true,
    previewLines: 80,
  },
};

function cloneConfig(config: ToolDisplayConfig): ToolDisplayConfig {
  return structuredClone(config);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizeOutputMode(
  value: unknown
): ToolDisplayOutputMode | undefined {
  return value === "compact" || value === "expanded" ? value : undefined;
}

function compactConfigSection<T extends Record<string, unknown>>(
  value: T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>;
}

function normalizeToolConfig(
  value: unknown
): Partial<ToolDisplayToolConfig> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const enabled = normalizeBoolean(value.enabled);
  return enabled === undefined ? undefined : { enabled };
}

function normalizeReadConfig(
  value: unknown
): Partial<ToolDisplayReadConfig> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const next: Partial<ToolDisplayReadConfig> = {};
  const enabled = normalizeBoolean(value.enabled);
  const fullSkillRead = normalizeBoolean(value.fullSkillRead);

  if (enabled !== undefined) {
    next.enabled = enabled;
  }

  if (fullSkillRead !== undefined) {
    next.fullSkillRead = fullSkillRead;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizePreviewConfig(
  value: unknown
): Partial<ToolDisplayPreviewConfig> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const next: Partial<ToolDisplayPreviewConfig> = {};
  const mode = normalizeOutputMode(value.mode);
  const collapsed = normalizeBoolean(value.collapsed);
  const previewLines = normalizePositiveInteger(value.previewLines);

  if (mode !== undefined) {
    next.mode = mode;
  }
  if (collapsed !== undefined) {
    next.collapsed = collapsed;
  }
  if (previewLines !== undefined) {
    next.previewLines = previewLines;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeBashOutputConfig(
  value: unknown
): Partial<ToolDisplayBashOutputConfig> | undefined {
  const next = normalizePreviewConfig(value) as
    | Partial<ToolDisplayBashOutputConfig>
    | undefined;
  if (!isPlainObject(value)) {
    return next;
  }

  const rtkHints = normalizeBoolean(value.rtkHints);
  if (rtkHints !== undefined) {
    return { ...next, rtkHints };
  }

  return next;
}

function normalizeDiffConfig(
  value: unknown
): Partial<ToolDisplayDiffConfig> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const next: Partial<ToolDisplayDiffConfig> = {};
  const enabled = normalizeBoolean(value.enabled);
  const collapsed = normalizeBoolean(value.collapsed);
  const previewLines = normalizePositiveInteger(value.previewLines);

  if (enabled !== undefined) {
    next.enabled = enabled;
  }
  if (collapsed !== undefined) {
    next.collapsed = collapsed;
  }
  if (previewLines !== undefined) {
    next.previewLines = previewLines;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function normalizeToolDisplayConfig(
  input: unknown
): ToolDisplayConfigLayer {
  if (!isPlainObject(input)) {
    return {};
  }

  const tools = isPlainObject(input.tools) ? input.tools : {};
  const read = normalizeReadConfig(tools.read);
  const search = normalizeToolConfig(tools.search);
  const edit = normalizeToolConfig(tools.edit);
  const write = normalizeToolConfig(tools.write);
  const compactTools = compactConfigSection({
    read,
    search,
    edit,
    write,
  }) as NonNullable<ToolDisplayConfigLayer["tools"]>;

  const output = isPlainObject(input.output) ? input.output : {};
  const outputRead = normalizePreviewConfig(output.read);
  const outputSearch = normalizePreviewConfig(output.search);
  const outputBash = normalizeBashOutputConfig(output.bash);
  const compactOutput = compactConfigSection({
    read: outputRead,
    search: outputSearch,
    bash: outputBash,
  }) as NonNullable<ToolDisplayConfigLayer["output"]>;

  const diff = normalizeDiffConfig(input.diff);
  const next: ToolDisplayConfigLayer = {};
  if (Object.keys(compactTools).length > 0) {
    next.tools = compactTools;
  }
  if (Object.keys(compactOutput).length > 0) {
    next.output = compactOutput;
  }
  if (diff !== undefined) {
    next.diff = diff;
  }
  return next;
}

export function resolveToolDisplayConfig(
  globalConfig: ToolDisplayConfigLayer | null,
  projectConfig: ToolDisplayConfigLayer | null
): ToolDisplayConfig {
  return {
    tools: {
      read: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.tools.read,
        ...globalConfig?.tools?.read,
        ...projectConfig?.tools?.read,
      },
      search: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.tools.search,
        ...globalConfig?.tools?.search,
        ...projectConfig?.tools?.search,
      },
      edit: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.tools.edit,
        ...globalConfig?.tools?.edit,
        ...projectConfig?.tools?.edit,
      },
      write: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.tools.write,
        ...globalConfig?.tools?.write,
        ...projectConfig?.tools?.write,
      },
    },
    output: {
      read: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.output.read,
        ...globalConfig?.output?.read,
        ...projectConfig?.output?.read,
      },
      search: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.output.search,
        ...globalConfig?.output?.search,
        ...projectConfig?.output?.search,
      },
      bash: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.output.bash,
        ...globalConfig?.output?.bash,
        ...projectConfig?.output?.bash,
      },
    },
    diff: {
      ...DEFAULT_TOOL_DISPLAY_CONFIG.diff,
      ...globalConfig?.diff,
      ...projectConfig?.diff,
    },
  };
}

export function getGlobalToolDisplayConfigPath(homeDir = homedir()): string {
  return join(homeDir, ".pi", "agent", "tool-display.json");
}

export function getProjectToolDisplayConfigPath(cwd = process.cwd()): string {
  return join(cwd, ".pi", "tool-display.json");
}

function loadConfigLayer(configPath: string): ToolDisplayConfigLayer | null {
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    return normalizeToolDisplayConfig(
      JSON.parse(readFileSync(configPath, "utf8"))
    );
  } catch {
    return null;
  }
}

export function loadToolDisplayConfig(
  cwd = process.cwd(),
  homeDir = homedir()
): ToolDisplayConfig {
  return resolveToolDisplayConfig(
    loadConfigLayer(getGlobalToolDisplayConfigPath(homeDir)),
    loadConfigLayer(getProjectToolDisplayConfigPath(cwd))
  );
}

function readConfigObjectForPersistence(
  configPath: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!existsSync(configPath)) {
    return { ok: true, value: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isPlainObject(parsed)) {
      return { ok: false, error: `${configPath} must contain a JSON object` };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid JSON in ${configPath}: ${message}` };
  }
}

function writeConfigObjectAtomically(
  configPath: string,
  value: Record<string, unknown>
): void {
  const tempPath = `${configPath}.${randomBytes(8).toString("hex")}.tmp`;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, configPath);
}

export function saveProjectToolDisplayConfig(
  cwd: string,
  config: unknown,
  homeDir = homedir()
):
  | { ok: true; configPath: string; config: ToolDisplayConfig }
  | { ok: false; configPath: string; error: string } {
  const configPath = getProjectToolDisplayConfigPath(cwd);
  const current = readConfigObjectForPersistence(configPath);

  if (!current.ok) {
    return { ok: false, configPath, error: current.error };
  }

  const normalized = normalizeToolDisplayConfig(config);
  const currentTools = isPlainObject(current.value.tools)
    ? current.value.tools
    : {};
  const currentOutput = isPlainObject(current.value.output)
    ? current.value.output
    : {};
  const next = {
    ...current.value,
    ...normalized,
    tools: {
      ...currentTools,
      ...normalized.tools,
    },
    output: {
      ...currentOutput,
      ...normalized.output,
    },
  };

  try {
    writeConfigObjectAtomically(configPath, next);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, configPath, error: message };
  }

  return { ok: true, configPath, config: loadToolDisplayConfig(cwd, homeDir) };
}

export function writeProjectToolDisplayConfig(
  cwd: string,
  config: ToolDisplayConfig,
  homeDir = homedir()
):
  | { ok: true; configPath: string; config: ToolDisplayConfig }
  | { ok: false; configPath: string; error: string } {
  const configPath = getProjectToolDisplayConfigPath(cwd);
  try {
    writeConfigObjectAtomically(
      configPath,
      config as unknown as Record<string, unknown>
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, configPath, error: message };
  }
  return { ok: true, configPath, config: loadToolDisplayConfig(cwd, homeDir) };
}

export function resetProjectToolDisplayConfig(
  cwd: string,
  homeDir = homedir()
) {
  return writeProjectToolDisplayConfig(
    cwd,
    DEFAULT_TOOL_DISPLAY_CONFIG,
    homeDir
  );
}

export function getToolDisplayPresetConfig(
  preset: ToolDisplayPresetName
): ToolDisplayConfig {
  const compact = defaultToolDisplayConfig();
  if (preset === "compact") {
    return compact;
  }
  if (preset === "off") {
    return {
      ...compact,
      tools: {
        read: { ...compact.tools.read, enabled: false },
        search: { enabled: false },
        edit: { enabled: false },
        write: { enabled: false },
      },
    };
  }
  return {
    ...compact,
    output: {
      read: { mode: "expanded", collapsed: false, previewLines: 80 },
      search: { mode: "expanded", collapsed: false, previewLines: 80 },
      bash: {
        mode: "expanded",
        collapsed: false,
        previewLines: 80,
        rtkHints: true,
      },
    },
    diff: { enabled: true, collapsed: false, previewLines: 160 },
  };
}

export function defaultToolDisplayConfig(): ToolDisplayConfig {
  return cloneConfig(DEFAULT_TOOL_DISPLAY_CONFIG);
}
