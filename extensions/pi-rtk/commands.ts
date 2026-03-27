import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import {
  DEFAULT_PI_RTK_CONFIG,
  getPiRtkConfigPath,
  resetPiRtkConfig,
  savePiRtkConfig,
} from "./config";
import { renderRtkStats } from "./stats";
import type { PiRtkConfig, PiRtkRuntime } from "./types";

function formatBoolean(value: boolean): string {
  return value ? "on" : "off";
}

function buildShowMessage(
  ctx: ExtensionCommandContext,
  runtime: PiRtkRuntime
): string {
  const config = runtime.getConfig();
  const status = runtime.getStatus();
  const metrics = runtime.metrics.snapshot();

  return [
    "RTK",
    `config: ${getPiRtkConfigPath(ctx.cwd)}`,
    `enabled: ${formatBoolean(config.enabled)}`,
    `mode: ${config.mode}`,
    `guardWhenRtkMissing: ${formatBoolean(config.guardWhenRtkMissing)}`,
    `showRewriteNotifications: ${formatBoolean(config.showRewriteNotifications)}`,
    `outputCompaction.enabled: ${formatBoolean(config.outputCompaction.enabled)}`,
    `outputCompaction.compactBash: ${formatBoolean(config.outputCompaction.compactBash)}`,
    `outputCompaction.compactGrep: ${formatBoolean(config.outputCompaction.compactGrep)}`,
    `outputCompaction.compactRead: ${formatBoolean(config.outputCompaction.compactRead)}`,
    `outputCompaction.readSourceFilteringEnabled: ${formatBoolean(config.outputCompaction.readSourceFilteringEnabled)}`,
    `rtkAvailable: ${formatBoolean(status.rtkAvailable)}`,
    `lastCheckedAt: ${status.lastCheckedAt ?? "never"}`,
    `lastError: ${status.lastError ?? "none"}`,
    `rewriteAttempts: ${metrics.rewriteAttempts}`,
    `rewritesApplied: ${metrics.rewritesApplied}`,
    `rewriteFallbacks: ${metrics.rewriteFallbacks}`,
    `userBashAttempts: ${metrics.userBashAttempts}`,
    `userBashRewrites: ${metrics.userBashRewrites}`,
  ].join("\n");
}

function applyConfigChange(
  ctx: ExtensionCommandContext,
  runtime: PiRtkRuntime,
  nextConfig: PiRtkConfig
): PiRtkConfig {
  const saved = savePiRtkConfig(ctx.cwd, nextConfig);
  runtime.setConfig(saved);
  return saved;
}

function buildHelpMessage(): string {
  return [
    "Usage: /rtk <command>",
    "show         Show config, runtime, and counters",
    "verify       Refresh RTK availability",
    "stats        Show rewrite stats",
    "clear-stats  Reset session counters",
    "reset        Restore default config",
    "help         Show this help",
    "enable       Enable RTK rewrites",
    "disable      Disable RTK rewrites",
    "mode rewrite Use rewrite mode",
    "mode suggest Use suggest mode",
  ].join("\n");
}

export function registerRtkCommands(
  pi: ExtensionAPI,
  runtime: PiRtkRuntime
): void {
  pi.registerCommand("rtk", {
    description: "Manage RTK rewrite settings and stats",
    handler: async (args, ctx) => {
      const [command = "help", ...rest] = args
        .trim()
        .split(/\s+/)
        .filter(Boolean);

      switch (command) {
        case "show": {
          ctx.ui.notify(buildShowMessage(ctx, runtime), "info");
          return;
        }

        case "verify": {
          const status = runtime.refreshRtkStatus();
          ctx.ui.notify(
            status.rtkAvailable
              ? `RTK available. Last checked: ${status.lastCheckedAt}`
              : `RTK unavailable: ${status.lastError ?? "unknown error"}`,
            status.rtkAvailable ? "info" : "warning"
          );
          return;
        }

        case "stats": {
          ctx.ui.notify(
            renderRtkStats(runtime.metrics.snapshot(), runtime.getConfig()),
            "info"
          );
          return;
        }

        case "clear-stats": {
          runtime.metrics.reset();
          ctx.ui.notify("RTK stats cleared", "info");
          return;
        }

        case "reset": {
          const nextConfig = resetPiRtkConfig(ctx.cwd);
          runtime.setConfig(nextConfig);
          runtime.metrics.reset();
          runtime.refreshRtkStatus();
          ctx.ui.notify("RTK config reset to defaults", "info");
          return;
        }

        case "enable": {
          const config = runtime.getConfig();
          applyConfigChange(ctx, runtime, {
            ...config,
            enabled: true,
          });
          ctx.ui.notify("RTK rewrites enabled", "info");
          return;
        }

        case "disable": {
          const config = runtime.getConfig();
          applyConfigChange(ctx, runtime, {
            ...config,
            enabled: false,
          });
          ctx.ui.notify("RTK rewrites disabled", "info");
          return;
        }

        case "mode": {
          const nextMode = rest[0];
          if (nextMode !== "rewrite" && nextMode !== "suggest") {
            ctx.ui.notify("Usage: /rtk mode <rewrite|suggest>", "warning");
            return;
          }

          const config = runtime.getConfig();
          applyConfigChange(ctx, runtime, {
            ...config,
            mode: nextMode,
          });
          ctx.ui.notify(`RTK mode set to ${nextMode}`, "info");
          return;
        }

        case "help":
        default: {
          if (command !== "help") {
            ctx.ui.notify(`Unknown /rtk command: ${command}`, "warning");
          }
          ctx.ui.notify(buildHelpMessage(), "info");
          return;
        }
      }
    },
  });
}
