import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";

export type ColorValue = ThemeColor | `#${string}`;

export const STATUS_BAR_SEMANTIC_COLORS = [
  "pi",
  "model",
  "path",
  "gitDirty",
  "gitClean",
  "thinking",
  "context",
  "contextWarn",
  "contextError",
  "cost",
  "tokens",
  "separator",
] as const;

export type SemanticColor = (typeof STATUS_BAR_SEMANTIC_COLORS)[number];

export type ColorScheme = Partial<Record<SemanticColor, ColorValue>>;

export const STATUS_BAR_SEGMENT_IDS = [
  "pi",
  "model",
  "path",
  "git",
  "token_in",
  "token_out",
  "token_total",
  "cost",
  "context_pct",
  "context_total",
  "time_spent",
  "time",
  "session",
  "hostname",
  "cache_read",
  "cache_write",
  "thinking",
  "extension_statuses",
] as const;

export type StatusBarSegmentId = (typeof STATUS_BAR_SEGMENT_IDS)[number];

export const STATUS_BAR_SEPARATOR_STYLES = [
  "powerline",
  "powerline-thin",
  "slash",
  "pipe",
  "block",
  "none",
  "ascii",
  "dot",
  "chevron",
  "star",
] as const;

export type StatusBarSeparatorStyle =
  (typeof STATUS_BAR_SEPARATOR_STYLES)[number];

export type StatusBarPreset =
  | "default"
  | "minimal"
  | "compact"
  | "full"
  | "nerd"
  | "ascii";

export interface StatusBarSegmentOptions {
  model?: { showThinkingLevel?: boolean };
  path?: {
    mode?: "basename" | "abbreviated" | "full";
    maxLength?: number;
  };
  git?: {
    showBranch?: boolean;
    showStaged?: boolean;
    showUnstaged?: boolean;
    showUntracked?: boolean;
  };
  time?: { format?: "12h" | "24h"; showSeconds?: boolean };
}

export interface StatusBarPresetDef {
  leftSegments: StatusBarSegmentId[];
  rightSegments: StatusBarSegmentId[];
  separator: string;
  segmentOptions?: StatusBarSegmentOptions;
  colors?: ColorScheme;
}

export interface BuiltinStatusBarPresetDef
  extends Omit<StatusBarPresetDef, "separator"> {
  separator: StatusBarSeparatorStyle;
}

export interface StatusBarSeparatorDef {
  left: string;
  right: string;
}

export interface GitStatus {
  branch: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface StatusBarContext {
  model:
    | { id: string; name?: string; reasoning?: boolean; contextWindow?: number }
    | undefined;
  thinkingLevel: string;
  sessionId: string | undefined;
  usageStats: UsageStats;
  contextPercent: number;
  contextWindow: number;
  usingSubscription: boolean;
  sessionStartTime: number;
  git: GitStatus;
  extensionStatuses: ReadonlyMap<string, string>;
  options: StatusBarSegmentOptions;
  theme: Theme;
  colors: ColorScheme;
}

export interface RenderedSegment {
  content: string;
  visible: boolean;
}

export interface StatusBarSegment {
  id: StatusBarSegmentId;
  render(ctx: StatusBarContext): RenderedSegment;
}
