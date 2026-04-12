import { mergeStatusBarSegmentOptions } from "./status-bar-config-utils.js";
import { getSeparator } from "./status-bar-icons.js";
import { getDefaultColors } from "./status-bar-theme.js";
import type {
  BuiltinStatusBarPresetDef,
  ColorScheme,
  StatusBarPreset,
  StatusBarPresetDef,
  StatusBarSegmentOptions,
} from "./status-bar-types.js";

const DEFAULT_COLORS: ColorScheme = getDefaultColors();

const MINIMAL_COLORS: ColorScheme = {
  ...DEFAULT_COLORS,
  pi: "dim",
  model: "text",
  path: "text",
  gitClean: "dim",
};

const NERD_COLORS: ColorScheme = {
  ...DEFAULT_COLORS,
  pi: "accent",
  model: "accent",
  path: "success",
  tokens: "muted",
  cost: "warning",
};

export const STATUS_BAR_PRESETS: Record<
  StatusBarPreset,
  BuiltinStatusBarPresetDef
> = {
  default: {
    leftSegments: [
      "pi",
      "model",
      "thinking",
      "path",
      "git",
      "context_pct",
      "cache_read",
      "cost",
    ],
    rightSegments: ["extension_statuses"],
    separator: "powerline-thin",
    colors: DEFAULT_COLORS,
    segmentOptions: {
      model: { showThinkingLevel: false },
      path: { mode: "basename" },
      git: {
        showBranch: true,
        showStaged: true,
        showUnstaged: true,
        showUntracked: true,
      },
    },
  },
  minimal: {
    leftSegments: ["path", "git"],
    rightSegments: ["context_pct"],
    separator: "slash",
    colors: MINIMAL_COLORS,
    segmentOptions: {
      path: { mode: "basename" },
      git: {
        showBranch: true,
        showStaged: false,
        showUnstaged: false,
        showUntracked: false,
      },
    },
  },
  compact: {
    leftSegments: ["model", "git"],
    rightSegments: ["cost", "context_pct", "extension_statuses"],
    separator: "powerline-thin",
    colors: DEFAULT_COLORS,
    segmentOptions: {
      model: { showThinkingLevel: false },
      git: {
        showBranch: true,
        showStaged: true,
        showUnstaged: true,
        showUntracked: false,
      },
    },
  },
  full: {
    leftSegments: ["pi", "hostname", "model", "thinking", "path", "git"],
    rightSegments: [
      "token_in",
      "token_out",
      "cache_read",
      "cost",
      "context_pct",
      "time_spent",
      "time",
      "extension_statuses",
    ],
    separator: "powerline",
    colors: DEFAULT_COLORS,
    segmentOptions: {
      model: { showThinkingLevel: false },
      path: { mode: "abbreviated", maxLength: 50 },
      git: {
        showBranch: true,
        showStaged: true,
        showUnstaged: true,
        showUntracked: true,
      },
      time: { format: "24h", showSeconds: false },
    },
  },
  nerd: {
    leftSegments: [
      "pi",
      "hostname",
      "model",
      "thinking",
      "path",
      "git",
      "session",
    ],
    rightSegments: [
      "token_in",
      "token_out",
      "cache_read",
      "cache_write",
      "cost",
      "context_pct",
      "context_total",
      "time_spent",
      "time",
      "extension_statuses",
    ],
    separator: "powerline",
    colors: NERD_COLORS,
    segmentOptions: {
      model: { showThinkingLevel: false },
      path: { mode: "abbreviated", maxLength: 60 },
      git: {
        showBranch: true,
        showStaged: true,
        showUnstaged: true,
        showUntracked: true,
      },
      time: { format: "24h", showSeconds: true },
    },
  },
  ascii: {
    leftSegments: ["model", "path", "git"],
    rightSegments: ["token_total", "cost", "context_pct", "extension_statuses"],
    separator: "ascii",
    colors: MINIMAL_COLORS,
    segmentOptions: {
      model: { showThinkingLevel: true },
      path: { mode: "abbreviated", maxLength: 40 },
      git: {
        showBranch: true,
        showStaged: true,
        showUnstaged: true,
        showUntracked: true,
      },
    },
  },
};

export function getStatusBarPreset(
  name: StatusBarPreset
): BuiltinStatusBarPresetDef {
  return STATUS_BAR_PRESETS[name] ?? STATUS_BAR_PRESETS.default;
}

export function resolveStatusBarPresetDef(config: {
  preset: StatusBarPreset;
  leftSegments?: StatusBarPresetDef["leftSegments"];
  rightSegments?: StatusBarPresetDef["rightSegments"];
  separator?: string;
  colors?: ColorScheme;
  segmentOptions?: StatusBarSegmentOptions;
}): StatusBarPresetDef {
  const preset = getStatusBarPreset(config.preset);

  return {
    ...preset,
    leftSegments: config.leftSegments ?? preset.leftSegments,
    rightSegments: config.rightSegments ?? preset.rightSegments,
    separator:
      config.separator ?? ` ${getSeparator(preset.separator).left} `,
    colors: { ...preset.colors, ...config.colors },
    segmentOptions: mergeStatusBarSegmentOptions(
      preset.segmentOptions,
      config.segmentOptions
    ),
  };
}
