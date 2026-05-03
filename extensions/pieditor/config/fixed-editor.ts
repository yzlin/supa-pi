export type FixedEditorShortcutList = string | string[];

export interface FixedEditorConfig {
  enabled?: boolean;
  mouseScroll?: boolean;
  scrollUpShortcuts?: FixedEditorShortcutList;
  scrollDownShortcuts?: FixedEditorShortcutList;
}

export interface FixedEditorRuntimeConfig {
  enabled: boolean;
  mouseScroll: boolean;
  scrollUpShortcuts: string[];
  scrollDownShortcuts: string[];
}

export const DEFAULT_FIXED_EDITOR_CONFIG: FixedEditorRuntimeConfig = {
  enabled: false,
  mouseScroll: true,
  scrollUpShortcuts: ["super+up"],
  scrollDownShortcuts: ["super+down"],
};

function normalizeShortcutList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const shortcut = value.trim();
    return shortcut ? [shortcut] : undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const shortcuts = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return shortcuts.length > 0 ? shortcuts : undefined;
}

export function normalizeFixedEditorConfig(
  value: unknown
): Partial<FixedEditorRuntimeConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const raw = value as Record<string, unknown>;
  const next: Partial<FixedEditorRuntimeConfig> = {};

  if (typeof raw.enabled === "boolean") {
    next.enabled = raw.enabled;
  }

  if (typeof raw.mouseScroll === "boolean") {
    next.mouseScroll = raw.mouseScroll;
  }

  if (Object.hasOwn(raw, "scrollUpShortcuts")) {
    const shortcuts = normalizeShortcutList(raw.scrollUpShortcuts);
    if (shortcuts) {
      next.scrollUpShortcuts = shortcuts;
    }
  }

  if (Object.hasOwn(raw, "scrollDownShortcuts")) {
    const shortcuts = normalizeShortcutList(raw.scrollDownShortcuts);
    if (shortcuts) {
      next.scrollDownShortcuts = shortcuts;
    }
  }

  return next;
}

export function mergeFixedEditorConfigs(
  ...configs: Array<Partial<FixedEditorRuntimeConfig> | null | undefined>
): FixedEditorRuntimeConfig {
  let merged: FixedEditorRuntimeConfig = {
    ...DEFAULT_FIXED_EDITOR_CONFIG,
    scrollUpShortcuts: [...DEFAULT_FIXED_EDITOR_CONFIG.scrollUpShortcuts],
    scrollDownShortcuts: [...DEFAULT_FIXED_EDITOR_CONFIG.scrollDownShortcuts],
  };

  for (const config of configs) {
    if (!config) {
      continue;
    }

    merged = {
      ...merged,
      ...config,
      scrollUpShortcuts:
        normalizeShortcutList(config.scrollUpShortcuts) ??
        merged.scrollUpShortcuts,
      scrollDownShortcuts:
        normalizeShortcutList(config.scrollDownShortcuts) ??
        merged.scrollDownShortcuts,
    };
  }

  return merged;
}
