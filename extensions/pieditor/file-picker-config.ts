import type {
  PickerConfig,
  PickerRuntimeConfig,
  PickerState,
  PreviewHighlightMode,
  TabCompletionMode,
} from "./file-picker-types.js";

export const DEFAULT_TAB_COMPLETION_MODE: TabCompletionMode = "bestMatch";
export const DEFAULT_PREVIEW_HIGHLIGHT_MODE: PreviewHighlightMode = "native";

export const DEFAULT_FILE_PICKER_CONFIG: PickerRuntimeConfig = {
  respectGitignore: true,
  skipHidden: true,
  allowFolderSelection: true,
  skipPatterns: ["node_modules"],
  tabCompletionMode: DEFAULT_TAB_COMPLETION_MODE,
  previewHighlightMode: DEFAULT_PREVIEW_HIGHLIGHT_MODE,
};

export function normalizeTabCompletionMode(value: unknown): TabCompletionMode {
  return value === "segment" || value === "bestMatch"
    ? value
    : DEFAULT_TAB_COMPLETION_MODE;
}

function normalizeSkipPatterns(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const skipPatterns = value
    .filter((pattern): pattern is string => typeof pattern === "string")
    .map((pattern) => pattern.trim())
    .filter(Boolean);

  return skipPatterns;
}

export function normalizePreviewHighlightMode(
  value: unknown
): PreviewHighlightMode {
  return value === "builtin" || value === "native"
    ? value
    : DEFAULT_PREVIEW_HIGHLIGHT_MODE;
}

export function normalizeFilePickerConfig(
  value: unknown
): Partial<PickerRuntimeConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const parsed = value as PickerConfig & {
    tabCompletionMode?: unknown;
    previewHighlightMode?: unknown;
  };
  const next: Partial<PickerRuntimeConfig> = {};

  if (typeof parsed.respectGitignore === "boolean") {
    next.respectGitignore = parsed.respectGitignore;
  }

  if (typeof parsed.skipHidden === "boolean") {
    next.skipHidden = parsed.skipHidden;
  }

  if (typeof parsed.allowFolderSelection === "boolean") {
    next.allowFolderSelection = parsed.allowFolderSelection;
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "skipPatterns")) {
    const skipPatterns = normalizeSkipPatterns(parsed.skipPatterns);
    if (skipPatterns) {
      next.skipPatterns = skipPatterns;
    }
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "tabCompletionMode")) {
    next.tabCompletionMode = normalizeTabCompletionMode(
      parsed.tabCompletionMode
    );
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "previewHighlightMode")) {
    next.previewHighlightMode = normalizePreviewHighlightMode(
      parsed.previewHighlightMode
    );
  }

  return next;
}

export function mergeFilePickerConfigs(
  ...configs: Array<Partial<PickerRuntimeConfig> | null | undefined>
): PickerRuntimeConfig {
  let merged: PickerRuntimeConfig = {
    ...DEFAULT_FILE_PICKER_CONFIG,
    skipPatterns: [...DEFAULT_FILE_PICKER_CONFIG.skipPatterns],
  };

  for (const config of configs) {
    if (!config) continue;

    merged = {
      ...merged,
      ...config,
      skipPatterns: config.skipPatterns ?? merged.skipPatterns,
      tabCompletionMode: config.tabCompletionMode ?? merged.tabCompletionMode,
      previewHighlightMode:
        config.previewHighlightMode ?? merged.previewHighlightMode,
    };
  }

  return merged;
}

export function createPickerState(config: PickerRuntimeConfig): PickerState {
  return {
    respectGitignore: config.respectGitignore,
    skipHidden: config.skipHidden,
    allowFolderSelection: config.allowFolderSelection,
  };
}
