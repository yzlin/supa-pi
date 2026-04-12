import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import type { StatusBarRuntimeConfig } from "../config/index.js";
import { getGitStatus } from "./git.js";
import { resolveStatusBarPresetDef } from "./presets.js";
import { renderStatusBarSegment } from "./segments.js";
import { fg, getDefaultColors } from "./theme.js";
import type {
  ColorScheme,
  StatusBarContext,
  StatusBarPresetDef,
  StatusBarSegmentId,
  UsageStats,
} from "./types.js";

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
  const coloredSeparator = fg(theme, "separator", presetDef.separator, colors);
  return ` ${parts.join(coloredSeparator)} `;
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
  const renderSide = (segmentIds: StatusBarSegmentId[]) =>
    segmentIds
      .map((segId) => renderSegmentWithWidth(segId, ctx))
      .filter((segment) => segment.visible)
      .map((segment) => ({ content: segment.content, width: segment.width }));

  const leftSegments = renderSide(presetDef.leftSegments);
  const rightSegments = renderSide(presetDef.rightSegments);

  const getSide = (segments: { content: string; width: number }[]) => {
    const content = buildContentFromParts(
      segments.map((segment) => segment.content),
      presetDef,
      ctx.theme,
      ctx.colors
    );

    return {
      content,
      width: visibleWidth(content),
    };
  };

  if (!leftSegments.length && !rightSegments.length) {
    return "";
  }

  let left = leftSegments;
  let right = rightSegments;
  let leftSide = getSide(left);
  let rightSide = getSide(right);

  while (leftSide.width + rightSide.width > width) {
    if (right.length > 0) {
      right = right.slice(0, -1);
      rightSide = getSide(right);
      continue;
    }

    if (left.length > 0) {
      left = left.slice(0, -1);
      leftSide = getSide(left);
      continue;
    }

    break;
  }

  if (!leftSide.content && !rightSide.content) {
    return "";
  }

  if (!leftSide.content) {
    return `${" ".repeat(Math.max(width - rightSide.width, 0))}${rightSide.content}`;
  }

  if (!rightSide.content) {
    return leftSide.content;
  }

  const gapWidth = Math.max(width - leftSide.width - rightSide.width, 1);
  return `${leftSide.content}${" ".repeat(gapWidth)}${rightSide.content}`;
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
  config: StatusBarRuntimeConfig;
  sessionStartTime: number;
  theme: Theme;
}): string {
  const { width, ctx, footerData, config, sessionStartTime, theme } = options;
  const presetDef = resolveStatusBarPresetDef(config);
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
