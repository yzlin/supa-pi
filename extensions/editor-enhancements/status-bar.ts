import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import { getGitStatus } from "./status-bar-git.js";
import { getSeparator } from "./status-bar-icons.js";
import { getStatusBarPreset } from "./status-bar-presets.js";
import { renderStatusBarSegment } from "./status-bar-segments.js";
import { fg, getDefaultColors } from "./status-bar-theme.js";
import type {
  ColorScheme,
  StatusBarContext,
  StatusBarPreset,
  StatusBarPresetDef,
  StatusBarSegmentId,
  UsageStats,
} from "./status-bar-types.js";

function renderSegmentWithWidth(
  segId: StatusBarSegmentId,
  ctx: StatusBarContext
): { content: string; width: number; visible: boolean } {
  const rendered = renderStatusBarSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }

  return {
    content: rendered.content,
    width: visibleWidth(rendered.content),
    visible: true,
  };
}

function buildContentFromParts(
  parts: string[],
  presetDef: StatusBarPresetDef,
  theme: Theme,
  colors: ColorScheme
): string {
  if (!parts.length) return "";
  const separator = getSeparator(presetDef.separator).left;
  const coloredSeparator = fg(theme, "separator", separator, colors);
  return ` ${parts.join(` ${coloredSeparator} `)} `;
}

function fitToWidth(content: string, width: number): string {
  if (width <= 0) return "";
  const actualWidth = visibleWidth(content);
  if (actualWidth === width) return content;
  if (actualWidth > width) return truncateToWidth(content, width);
  return content + " ".repeat(width - actualWidth);
}

function computeTopContent(
  ctx: StatusBarContext,
  presetDef: StatusBarPresetDef,
  width: number
): string {
  const separator = getSeparator(presetDef.separator);
  const separatorWidth = visibleWidth(separator.left) + 2;
  const allSegmentIds = [...presetDef.leftSegments, ...presetDef.rightSegments];

  const renderedSegments: { content: string; width: number }[] = [];
  for (const segId of allSegmentIds) {
    const rendered = renderSegmentWithWidth(segId, ctx);
    if (rendered.visible) {
      renderedSegments.push({
        content: rendered.content,
        width: rendered.width,
      });
    }
  }

  if (!renderedSegments.length) {
    return "";
  }

  let used = 2;
  const accepted: string[] = [];
  for (const segment of renderedSegments) {
    const needed = segment.width + (accepted.length ? separatorWidth : 0);
    if (used + needed > width) break;
    accepted.push(segment.content);
    used += needed;
  }

  return buildContentFromParts(accepted, presetDef, ctx.theme, ctx.colors);
}

function collectUsageStats(ctx: ExtensionContext): {
  usageStats: UsageStats;
  thinkingLevel: string;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let thinkingLevel = "off";

  const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
  for (const entry of sessionEvents) {
    if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
      thinkingLevel = entry.thinkingLevel;
    }

    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }

    const message = entry.message as AssistantMessage;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      continue;
    }

    input += message.usage.input;
    output += message.usage.output;
    cacheRead += message.usage.cacheRead;
    cacheWrite += message.usage.cacheWrite;
    cost += message.usage.cost.total;
  }

  return {
    usageStats: { input, output, cacheRead, cacheWrite, cost },
    thinkingLevel,
  };
}

export function buildStatusBarContext(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider | null,
  presetDef: StatusBarPresetDef,
  sessionStartTime: number,
  theme: Theme
): StatusBarContext {
  const colors: ColorScheme = presetDef.colors ?? getDefaultColors();
  const { usageStats, thinkingLevel } = collectUsageStats(ctx);
  const contextUsage = ctx.getContextUsage?.();
  const contextPercent = contextUsage?.percent ?? 0;
  const contextWindow =
    contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const providerBranch = footerData?.getGitBranch() ?? null;
  const usingSubscription = ctx.model
    ? ((ctx.modelRegistry as any)?.isUsingOAuth?.(ctx.model) ?? false)
    : false;

  return {
    model: ctx.model,
    thinkingLevel,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    usageStats,
    contextPercent,
    contextWindow,
    usingSubscription,
    sessionStartTime,
    git: getGitStatus(providerBranch),
    extensionStatuses: footerData?.getExtensionStatuses() ?? new Map(),
    options: presetDef.segmentOptions ?? {},
    theme,
    colors,
  };
}

export function renderStatusBarLine(options: {
  width: number;
  ctx: ExtensionContext;
  footerData: ReadonlyFooterDataProvider | null;
  preset: StatusBarPreset;
  sessionStartTime: number;
  theme: Theme;
}): string {
  const { width, ctx, footerData, preset, sessionStartTime, theme } = options;
  const presetDef = getStatusBarPreset(preset);
  const statusBarContext = buildStatusBarContext(
    ctx,
    footerData,
    presetDef,
    sessionStartTime,
    theme
  );
  const content = computeTopContent(statusBarContext, presetDef, width);

  if (!content) {
    return theme.fg("borderMuted", "─".repeat(width));
  }

  return fitToWidth(content, width);
}
