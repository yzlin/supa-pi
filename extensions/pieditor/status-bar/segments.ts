import { hostname as osHostname } from "node:os";
import { basename } from "node:path";

import { visibleWidth } from "@mariozechner/pi-tui";

import { getIcons, getThinkingText, SEP_DOT } from "./icons.js";
import { applyColor, fg, rainbow } from "./theme.js";
import type {
  RenderedSegment,
  SemanticColor,
  StatusBarContext,
  StatusBarSegment,
  StatusBarSegmentId,
} from "./types.js";

function color(
  ctx: StatusBarContext,
  semantic: SemanticColor,
  text: string
): string {
  return fg(ctx.theme, semantic, text, ctx.colors);
}

function withIcon(icon: string, text: string): string {
  return icon ? `${icon} ${text}` : text;
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

const piSegment: StatusBarSegment = {
  id: "pi",
  render(ctx) {
    const icons = getIcons();
    if (!icons.pi) return { content: "", visible: false };
    return { content: color(ctx, "pi", `${icons.pi} `), visible: true };
  },
};

const modelSegment: StatusBarSegment = {
  id: "model",
  render(ctx) {
    const icons = getIcons();
    const opts = ctx.options.model ?? {};

    let modelName = ctx.model?.name || ctx.model?.id || "no-model";
    if (modelName.startsWith("Claude ")) {
      modelName = modelName.slice(7);
    }

    let content = withIcon(icons.model, modelName);
    if (opts.showThinkingLevel !== false && ctx.model?.reasoning) {
      const level = ctx.thinkingLevel || "off";
      if (level !== "off") {
        const thinkingText = getThinkingText(level);
        if (thinkingText) {
          content += `${SEP_DOT}${thinkingText}`;
        }
      }
    }

    return { content: color(ctx, "model", content), visible: true };
  },
};

const pathSegment: StatusBarSegment = {
  id: "path",
  render(ctx) {
    const icons = getIcons();
    const opts = ctx.options.path ?? {};
    const mode = opts.mode ?? "basename";

    let pwd = process.cwd();
    const home = process.env.HOME || process.env.USERPROFILE;

    if (mode === "basename") {
      pwd = basename(pwd) || pwd;
    } else {
      if (home && pwd.startsWith(home)) {
        pwd = `~${pwd.slice(home.length)}`;
      }

      if (pwd.startsWith("/work/")) {
        pwd = pwd.slice(6);
      }

      if (mode === "abbreviated") {
        const maxLen = opts.maxLength ?? 40;
        if (pwd.length > maxLen) {
          pwd = `…${pwd.slice(-(maxLen - 1))}`;
        }
      }
    }

    return {
      content: color(ctx, "path", withIcon(icons.folder, pwd)),
      visible: true,
    };
  },
};

const gitSegment: StatusBarSegment = {
  id: "git",
  render(ctx) {
    const icons = getIcons();
    const opts = ctx.options.git ?? {};
    const { branch, staged, unstaged, untracked } = ctx.git;
    const hasChanges = staged > 0 || unstaged > 0 || untracked > 0;
    const gitStatus = hasChanges ? { staged, unstaged, untracked } : null;

    if (!branch && !gitStatus) return { content: "", visible: false };

    const showBranch = opts.showBranch !== false;
    const branchColor: SemanticColor = hasChanges ? "gitDirty" : "gitClean";

    let content = "";
    if (showBranch && branch) {
      content = color(ctx, branchColor, withIcon(icons.branch, branch));
    }

    if (gitStatus) {
      const indicators: string[] = [];
      if (opts.showUnstaged !== false && gitStatus.unstaged > 0) {
        indicators.push(
          applyColor(ctx.theme, "warning", `*${gitStatus.unstaged}`)
        );
      }
      if (opts.showStaged !== false && gitStatus.staged > 0) {
        indicators.push(
          applyColor(ctx.theme, "success", `+${gitStatus.staged}`)
        );
      }
      if (opts.showUntracked !== false && gitStatus.untracked > 0) {
        indicators.push(
          applyColor(ctx.theme, "muted", `?${gitStatus.untracked}`)
        );
      }
      if (indicators.length > 0) {
        const indicatorText = indicators.join(" ");
        if (!content && showBranch === false) {
          content =
            color(ctx, branchColor, icons.git ? `${icons.git} ` : "") +
            indicatorText;
        } else {
          content += content ? ` ${indicatorText}` : indicatorText;
        }
      }
    }

    return content
      ? { content, visible: true }
      : { content: "", visible: false };
  },
};

const thinkingSegment: StatusBarSegment = {
  id: "thinking",
  render(ctx) {
    const level = ctx.thinkingLevel || "off";
    const levelText: Record<string, string> = {
      off: "off",
      minimal: "min",
      low: "low",
      medium: "med",
      high: "high",
      xhigh: "xhigh",
    };

    const content = `think:${levelText[level] || level}`;
    if (level === "high" || level === "xhigh") {
      return { content: rainbow(content), visible: true };
    }
    return { content: color(ctx, "thinking", content), visible: true };
  },
};

const CAVEMAN_EXTENSION_STATUS_KEY = "caveman";

const cavemanSegment: StatusBarSegment = {
  id: "caveman",
  render(ctx) {
    const status = ctx.extensionStatuses.get(CAVEMAN_EXTENSION_STATUS_KEY);
    if (!status || visibleWidth(status) <= 0) {
      return { content: "", visible: false };
    }

    return {
      content: color(ctx, "thinking", status),
      visible: true,
    };
  },
};

const tokenInSegment: StatusBarSegment = {
  id: "token_in",
  render(ctx) {
    const icons = getIcons();
    if (!ctx.usageStats.input) return { content: "", visible: false };
    return {
      content: color(
        ctx,
        "tokens",
        withIcon(icons.input, formatTokens(ctx.usageStats.input))
      ),
      visible: true,
    };
  },
};

const tokenOutSegment: StatusBarSegment = {
  id: "token_out",
  render(ctx) {
    const icons = getIcons();
    if (!ctx.usageStats.output) return { content: "", visible: false };
    return {
      content: color(
        ctx,
        "tokens",
        withIcon(icons.output, formatTokens(ctx.usageStats.output))
      ),
      visible: true,
    };
  },
};

const tokenTotalSegment: StatusBarSegment = {
  id: "token_total",
  render(ctx) {
    const icons = getIcons();
    const total =
      ctx.usageStats.input +
      ctx.usageStats.output +
      ctx.usageStats.cacheRead +
      ctx.usageStats.cacheWrite;
    if (!total) return { content: "", visible: false };
    return {
      content: color(
        ctx,
        "tokens",
        withIcon(icons.tokens, formatTokens(total))
      ),
      visible: true,
    };
  },
};

const costSegment: StatusBarSegment = {
  id: "cost",
  render(ctx) {
    const { cost } = ctx.usageStats;
    if (!cost && !ctx.usingSubscription) {
      return { content: "", visible: false };
    }

    const costDisplay = ctx.usingSubscription ? "(sub)" : `$${cost.toFixed(2)}`;
    return { content: color(ctx, "cost", costDisplay), visible: true };
  },
};

const contextPctSegment: StatusBarSegment = {
  id: "context_pct",
  render(ctx) {
    const icons = getIcons();
    if (!ctx.contextWindow) return { content: "", visible: false };
    const text = `${ctx.contextPercent.toFixed(1)}%/${formatTokens(ctx.contextWindow)}`;

    if (ctx.contextPercent > 90) {
      return {
        content: withIcon(icons.context, color(ctx, "contextError", text)),
        visible: true,
      };
    }
    if (ctx.contextPercent > 70) {
      return {
        content: withIcon(icons.context, color(ctx, "contextWarn", text)),
        visible: true,
      };
    }

    return {
      content: withIcon(icons.context, color(ctx, "context", text)),
      visible: true,
    };
  },
};

const contextTotalSegment: StatusBarSegment = {
  id: "context_total",
  render(ctx) {
    const icons = getIcons();
    if (!ctx.contextWindow) return { content: "", visible: false };
    return {
      content: color(
        ctx,
        "context",
        withIcon(icons.context, formatTokens(ctx.contextWindow))
      ),
      visible: true,
    };
  },
};

const timeSpentSegment: StatusBarSegment = {
  id: "time_spent",
  render(ctx) {
    const icons = getIcons();
    const elapsed = Date.now() - ctx.sessionStartTime;
    if (elapsed < 1000) return { content: "", visible: false };
    return {
      content: withIcon(icons.time, formatDuration(elapsed)),
      visible: true,
    };
  },
};

const timeSegment: StatusBarSegment = {
  id: "time",
  render(ctx) {
    const icons = getIcons();
    const opts = ctx.options.time ?? {};
    const now = new Date();

    let hours = now.getHours();
    let suffix = "";
    if (opts.format === "12h") {
      suffix = hours >= 12 ? "pm" : "am";
      hours = hours % 12 || 12;
    }

    const mins = now.getMinutes().toString().padStart(2, "0");
    let timeStr = `${hours}:${mins}`;
    if (opts.showSeconds) {
      timeStr += `:${now.getSeconds().toString().padStart(2, "0")}`;
    }
    timeStr += suffix;

    return { content: withIcon(icons.time, timeStr), visible: true };
  },
};

const sessionSegment: StatusBarSegment = {
  id: "session",
  render(ctx) {
    const icons = getIcons();
    return {
      content: withIcon(icons.session, ctx.sessionId?.slice(0, 8) || "new"),
      visible: true,
    };
  },
};

const hostnameSegment: StatusBarSegment = {
  id: "hostname",
  render() {
    const icons = getIcons();
    return {
      content: withIcon(icons.host, osHostname().split(".")[0] || "host"),
      visible: true,
    };
  },
};

const cacheReadSegment: StatusBarSegment = {
  id: "cache_read",
  render(ctx) {
    const icons = getIcons();
    if (!ctx.usageStats.cacheRead) return { content: "", visible: false };
    return {
      content: color(
        ctx,
        "tokens",
        [icons.cache, icons.input, formatTokens(ctx.usageStats.cacheRead)]
          .filter(Boolean)
          .join(" ")
      ),
      visible: true,
    };
  },
};

const cacheWriteSegment: StatusBarSegment = {
  id: "cache_write",
  render(ctx) {
    const icons = getIcons();
    if (!ctx.usageStats.cacheWrite) return { content: "", visible: false };
    return {
      content: color(
        ctx,
        "tokens",
        [icons.cache, icons.output, formatTokens(ctx.usageStats.cacheWrite)]
          .filter(Boolean)
          .join(" ")
      ),
      visible: true,
    };
  },
};

function shouldRenderExtensionStatus(
  ctx: StatusBarContext,
  key: string,
  value: string
): boolean {
  if (ctx.dedicatedExtensionStatusKeys.has(key)) {
    return false;
  }

  if (!value || value.trimStart().startsWith("[")) {
    return false;
  }

  return visibleWidth(value) > 0;
}

function stripExtensionStatusSuffix(value: string): string {
  return value.replace(/(\x1b\[[0-9;]*m|\s|·|[|])+$/, "");
}

const extensionStatusesSegment: StatusBarSegment = {
  id: "extension_statuses",
  render(ctx) {
    if (!ctx.extensionStatuses.size) return { content: "", visible: false };

    const parts: string[] = [];
    for (const [key, value] of ctx.extensionStatuses.entries()) {
      if (!shouldRenderExtensionStatus(ctx, key, value)) {
        continue;
      }

      const stripped = stripExtensionStatusSuffix(value);
      if (visibleWidth(stripped) > 0) {
        parts.push(stripped);
      }
    }

    if (!parts.length) return { content: "", visible: false };
    return { content: parts.join(` ${SEP_DOT} `), visible: true };
  },
};

const SEGMENTS: Record<StatusBarSegmentId, StatusBarSegment> = {
  pi: piSegment,
  model: modelSegment,
  path: pathSegment,
  git: gitSegment,
  token_in: tokenInSegment,
  token_out: tokenOutSegment,
  token_total: tokenTotalSegment,
  cost: costSegment,
  context_pct: contextPctSegment,
  context_total: contextTotalSegment,
  time_spent: timeSpentSegment,
  time: timeSegment,
  session: sessionSegment,
  hostname: hostnameSegment,
  cache_read: cacheReadSegment,
  cache_write: cacheWriteSegment,
  thinking: thinkingSegment,
  caveman: cavemanSegment,
  extension_statuses: extensionStatusesSegment,
};

export function renderStatusBarSegment(
  id: StatusBarSegmentId,
  ctx: StatusBarContext
): RenderedSegment {
  const segment = SEGMENTS[id];
  return segment ? segment.render(ctx) : { content: "", visible: false };
}
