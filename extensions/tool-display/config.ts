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
export type ToolDisplayDiffIndicatorMode = "bars" | "classic" | "none";
export type ToolDisplayDiffViewMode = "auto" | "split" | "unified";
export type ToolDisplayPresetName = "compact" | "verbose" | "off";

export interface ToolDisplayToolConfig {
  enabled: boolean;
}

export const TOOL_DISPLAY_FULL_READ_MAX_BYTES = 256 * 1024;

export type ToolDisplayFullReadSource = "registeredSkills" | "patterns";
export type ToolDisplayFullReadProvenance = "default" | "global" | "project";

export interface ToolDisplayFullReadTarget {
  name: string;
  enabled: boolean;
  source: ToolDisplayFullReadSource;
  maxBytes: number;
  ignorePagination: boolean;
  baseDir?: string;
  include?: string[];
  exclude?: string[];
  provenance: ToolDisplayFullReadProvenance;
  warnings: string[];
}

export interface ToolDisplayFullReadConfig {
  enabled: boolean;
  targets: ToolDisplayFullReadTarget[];
  warnings: string[];
}

export interface ToolDisplayReadConfig extends ToolDisplayToolConfig {
  fullRead: ToolDisplayFullReadConfig;
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
  viewMode: ToolDisplayDiffViewMode;
  splitMinWidth: number;
  wordWrap: boolean;
  indicatorMode: ToolDisplayDiffIndicatorMode;
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

interface ToolDisplayFullReadConfigLayer
  extends Partial<ToolDisplayFullReadConfig> {
  order?: string[];
  targets?: Partial<ToolDisplayFullReadTarget>[];
}

interface ToolDisplayReadConfigLayer
  extends Partial<Omit<ToolDisplayReadConfig, "fullRead">> {
  fullRead?: ToolDisplayFullReadConfigLayer;
}

export interface ToolDisplayConfigLayer {
  tools?: {
    read?: ToolDisplayReadConfigLayer;
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
      fullRead: {
        enabled: true,
        targets: [
          {
            name: "skills",
            enabled: true,
            source: "registeredSkills",
            maxBytes: TOOL_DISPLAY_FULL_READ_MAX_BYTES,
            ignorePagination: true,
            provenance: "default",
            warnings: [],
          },
          {
            name: "user-rules",
            enabled: true,
            source: "patterns",
            maxBytes: TOOL_DISPLAY_FULL_READ_MAX_BYTES,
            ignorePagination: true,
            baseDir: "~/.pi/agent/rules",
            include: ["**/*.md"],
            provenance: "default",
            warnings: [],
          },
          {
            name: "project-rules",
            enabled: true,
            source: "patterns",
            maxBytes: TOOL_DISPLAY_FULL_READ_MAX_BYTES,
            ignorePagination: true,
            baseDir: ".pi/rules",
            include: ["**/*.md"],
            provenance: "default",
            warnings: [],
          },
        ],
        warnings: [],
      },
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
    viewMode: "auto",
    splitMinWidth: 120,
    wordWrap: true,
    indicatorMode: "bars",
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

function normalizeDiffViewMode(
  value: unknown
): ToolDisplayDiffViewMode | undefined {
  return value === "auto" || value === "split" || value === "unified"
    ? value
    : undefined;
}

function normalizeDiffIndicatorMode(
  value: unknown
): ToolDisplayDiffIndicatorMode | undefined {
  return value === "bars" || value === "classic" || value === "none"
    ? value
    : undefined;
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

function normalizeStringArray(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return undefined;
  }
  return value;
}

function normalizeFullReadSource(
  value: unknown
): ToolDisplayFullReadSource | undefined {
  return value === "registeredSkills" || value === "patterns"
    ? value
    : undefined;
}

function normalizeFullReadMaxBytes(
  value: unknown,
  warnings: string[],
  targetName: string
): number | undefined {
  const maxBytes = normalizePositiveInteger(value);
  if (maxBytes === undefined) {
    return undefined;
  }
  if (maxBytes <= TOOL_DISPLAY_FULL_READ_MAX_BYTES) {
    return maxBytes;
  }

  warnings.push(
    `target ${targetName}: maxBytes clamped to ${TOOL_DISPLAY_FULL_READ_MAX_BYTES}`
  );
  return TOOL_DISPLAY_FULL_READ_MAX_BYTES;
}

function normalizeFullReadTarget(
  value: unknown
): Partial<ToolDisplayFullReadTarget> | undefined {
  if (
    !isPlainObject(value) ||
    typeof value.name !== "string" ||
    value.name.length === 0
  ) {
    return undefined;
  }

  const warnings = [...(normalizeStringArray(value.warnings) ?? [])];
  const source = normalizeFullReadSource(value.source);
  const enabled = normalizeBoolean(value.enabled);
  const maxBytes = normalizeFullReadMaxBytes(
    value.maxBytes,
    warnings,
    value.name
  );
  const ignorePagination = normalizeBoolean(value.ignorePagination);
  const baseDir = typeof value.baseDir === "string" ? value.baseDir : undefined;
  const include = normalizeStringArray(value.include);
  const exclude = normalizeStringArray(value.exclude);

  if (value.source !== undefined && source === undefined) {
    warnings.push(`target ${value.name}: invalid source ignored`);
  }
  if (source === "patterns" && baseDir === undefined) {
    warnings.push(`target ${value.name}: pattern target missing baseDir`);
  }
  if (source === "patterns" && include === undefined) {
    warnings.push(`target ${value.name}: pattern target missing include`);
  }

  return compactConfigSection({
    name: value.name,
    enabled,
    source,
    maxBytes,
    ignorePagination,
    baseDir,
    include,
    exclude,
    warnings,
  }) as Partial<ToolDisplayFullReadTarget>;
}

function normalizeFullReadConfig(
  value: unknown
): ToolDisplayFullReadConfigLayer | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const enabled = normalizeBoolean(value.enabled);
  const order = normalizeStringArray(value.order);
  const warnings = [...(normalizeStringArray(value.warnings) ?? [])];
  const rawTargets = Array.isArray(value.targets) ? value.targets : undefined;
  const targets: Partial<ToolDisplayFullReadTarget>[] | undefined = rawTargets
    ? []
    : undefined;

  if (rawTargets && targets) {
    for (const [index, target] of rawTargets.entries()) {
      const normalizedTarget = normalizeFullReadTarget(target);
      if (normalizedTarget) {
        targets.push(normalizedTarget);
        continue;
      }

      warnings.push(
        isPlainObject(target)
          ? `target at index ${index}: missing name ignored`
          : `target at index ${index}: invalid target ignored`
      );
    }
  }

  return compactConfigSection({
    enabled,
    order,
    targets,
    warnings: warnings.length > 0 ? warnings : undefined,
  }) as ToolDisplayFullReadConfigLayer;
}

function normalizeReadConfig(
  value: unknown
): ToolDisplayReadConfigLayer | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const next: ToolDisplayReadConfigLayer = {};
  const enabled = normalizeBoolean(value.enabled);
  const fullRead = normalizeFullReadConfig(value.fullRead);

  if (enabled !== undefined) {
    next.enabled = enabled;
  }

  if (fullRead !== undefined && Object.keys(fullRead).length > 0) {
    next.fullRead = fullRead;
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
  if (!isPlainObject(value)) {
    return undefined;
  }

  const next: Partial<ToolDisplayBashOutputConfig> =
    normalizePreviewConfig(value) ?? {};
  const rtkHints = normalizeBoolean(value.rtkHints);
  if (rtkHints !== undefined) {
    next.rtkHints = rtkHints;
  }

  return Object.keys(next).length > 0 ? next : undefined;
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
  const viewMode = normalizeDiffViewMode(value.viewMode);
  const splitMinWidth = normalizePositiveInteger(value.splitMinWidth);
  const wordWrap = normalizeBoolean(value.wordWrap);
  const indicatorMode = normalizeDiffIndicatorMode(value.indicatorMode);

  if (enabled !== undefined) {
    next.enabled = enabled;
  }
  if (collapsed !== undefined) {
    next.collapsed = collapsed;
  }
  if (previewLines !== undefined) {
    next.previewLines = previewLines;
  }
  if (viewMode !== undefined) {
    next.viewMode = viewMode;
  }
  if (splitMinWidth !== undefined) {
    next.splitMinWidth = splitMinWidth;
  }
  if (wordWrap !== undefined) {
    next.wordWrap = wordWrap;
  }
  if (indicatorMode !== undefined) {
    next.indicatorMode = indicatorMode;
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

function mergeFullReadConfig(
  globalConfig: ToolDisplayConfigLayer | null,
  projectConfig: ToolDisplayConfigLayer | null
): ToolDisplayFullReadConfig {
  const defaultFullRead = DEFAULT_TOOL_DISPLAY_CONFIG.tools.read.fullRead;
  const globalFullRead = globalConfig?.tools?.read?.fullRead;
  const projectFullRead = projectConfig?.tools?.read?.fullRead;
  const targetMap = new Map<string, ToolDisplayFullReadTarget>();

  function applyTargets(
    targets: Partial<ToolDisplayFullReadTarget>[] | undefined,
    provenance: ToolDisplayFullReadProvenance
  ): void {
    for (const target of targets ?? []) {
      if (!target.name) {
        continue;
      }

      const previous = targetMap.get(target.name);
      targetMap.set(target.name, {
        enabled: true,
        source: "patterns",
        maxBytes: TOOL_DISPLAY_FULL_READ_MAX_BYTES,
        ignorePagination: true,
        ...previous,
        ...target,
        name: target.name,
        provenance,
        warnings: [...(previous?.warnings ?? []), ...(target.warnings ?? [])],
      });
    }
  }

  applyTargets(defaultFullRead.targets, "default");
  applyTargets(globalFullRead?.targets, "global");
  applyTargets(projectFullRead?.targets, "project");

  const seen = new Set<string>();
  const orderedTargets: ToolDisplayFullReadTarget[] = [];

  function appendTarget(target: ToolDisplayFullReadTarget): void {
    if (seen.has(target.name)) {
      return;
    }
    orderedTargets.push(target);
    seen.add(target.name);
  }

  for (const name of [
    ...(globalFullRead?.order ?? []),
    ...(projectFullRead?.order ?? []),
  ]) {
    const target = targetMap.get(name);
    if (target) {
      appendTarget(target);
    }
  }

  for (const target of targetMap.values()) {
    appendTarget(target);
  }

  return {
    enabled:
      projectFullRead?.enabled ??
      globalFullRead?.enabled ??
      defaultFullRead.enabled,
    targets: orderedTargets,
    warnings: [
      ...(globalFullRead?.warnings ?? []),
      ...(projectFullRead?.warnings ?? []),
    ],
  };
}

export function loadToolDisplayConfigFromLayers(
  globalConfig: unknown,
  projectConfig: unknown
): ToolDisplayConfig {
  const normalizedGlobalConfig = globalConfig
    ? normalizeToolDisplayConfig(globalConfig)
    : null;
  const normalizedProjectConfig = projectConfig
    ? normalizeToolDisplayConfig(projectConfig)
    : null;

  return {
    tools: {
      read: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.tools.read,
        ...normalizedGlobalConfig?.tools?.read,
        ...normalizedProjectConfig?.tools?.read,
        fullRead: mergeFullReadConfig(
          normalizedGlobalConfig,
          normalizedProjectConfig
        ),
      },
      search: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.tools.search,
        ...normalizedGlobalConfig?.tools?.search,
        ...normalizedProjectConfig?.tools?.search,
      },
      edit: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.tools.edit,
        ...normalizedGlobalConfig?.tools?.edit,
        ...normalizedProjectConfig?.tools?.edit,
      },
      write: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.tools.write,
        ...normalizedGlobalConfig?.tools?.write,
        ...normalizedProjectConfig?.tools?.write,
      },
    },
    output: {
      read: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.output.read,
        ...normalizedGlobalConfig?.output?.read,
        ...normalizedProjectConfig?.output?.read,
      },
      search: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.output.search,
        ...normalizedGlobalConfig?.output?.search,
        ...normalizedProjectConfig?.output?.search,
      },
      bash: {
        ...DEFAULT_TOOL_DISPLAY_CONFIG.output.bash,
        ...normalizedGlobalConfig?.output?.bash,
        ...normalizedProjectConfig?.output?.bash,
      },
    },
    diff: {
      ...DEFAULT_TOOL_DISPLAY_CONFIG.diff,
      ...normalizedGlobalConfig?.diff,
      ...normalizedProjectConfig?.diff,
    },
  };
}

export function getGlobalToolDisplayConfigPath(homeDir = homedir()): string {
  return join(homeDir, ".pi", "agent", "tool-display.json");
}

export function getProjectToolDisplayConfigPath(cwd = process.cwd()): string {
  return join(cwd, ".pi", "tool-display.json");
}

function loadConfigLayer(configPath: string): unknown {
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

export function loadToolDisplayConfig(
  cwd = process.cwd(),
  homeDir = homedir()
): ToolDisplayConfig {
  return loadToolDisplayConfigFromLayers(
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
  const currentDiff = isPlainObject(current.value.diff)
    ? current.value.diff
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
    ...(Object.keys(currentDiff).length > 0 || normalized.diff !== undefined
      ? {
          diff: {
            ...currentDiff,
            ...normalized.diff,
          },
        }
      : {}),
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
    diff: {
      ...compact.diff,
      enabled: true,
      collapsed: false,
      previewLines: 160,
    },
  };
}

export function defaultToolDisplayConfig(): ToolDisplayConfig {
  return cloneConfig(DEFAULT_TOOL_DISPLAY_CONFIG);
}
