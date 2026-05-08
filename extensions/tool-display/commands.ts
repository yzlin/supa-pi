import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
  getProjectToolDisplayConfigPath,
  getToolDisplayPresetConfig,
  loadToolDisplayConfig,
  resetProjectToolDisplayConfig,
  type ToolDisplayConfig,
  type ToolDisplayPresetName,
  writeProjectToolDisplayConfig,
} from "./config";

const SPLIT_REGEX = /\s+/;
const TRAILING_SPACE_REGEX = /\s$/;

const TOOL_DISPLAY_SUBCOMMANDS = [
  { value: "show", description: "Show resolved tool-display config" },
  { value: "preset", description: "Write a preset project config" },
  { value: "reset", description: "Write default project config" },
  { value: "help", description: "Show help" },
] as const;

const TOOL_DISPLAY_PRESETS = [
  { value: "compact", description: "Enable compact opencode-like output" },
  { value: "verbose", description: "Enable expanded output previews" },
  { value: "off", description: "Disable tool-display tool overrides" },
] as const;

function formatBoolean(value: boolean): string {
  return value ? "on" : "off";
}

function isToolDisplayPresetName(
  value: string | undefined
): value is ToolDisplayPresetName {
  return value === "compact" || value === "verbose" || value === "off";
}

function buildShowMessage(ctx: ExtensionCommandContext): string {
  const config = loadToolDisplayConfig(ctx.cwd);
  return [
    "tool-display",
    `projectConfig: ${getProjectToolDisplayConfigPath(ctx.cwd)}`,
    `tools.read.enabled: ${formatBoolean(config.tools.read.enabled)}`,
    `tools.read.fullSkillRead: ${formatBoolean(config.tools.read.fullSkillRead)}`,
    `tools.search.enabled: ${formatBoolean(config.tools.search.enabled)}`,
    `tools.edit.enabled: ${formatBoolean(config.tools.edit.enabled)}`,
    `tools.write.enabled: ${formatBoolean(config.tools.write.enabled)}`,
    `output.read: ${config.output.read.mode}, collapsed=${formatBoolean(config.output.read.collapsed)}, previewLines=${config.output.read.previewLines}`,
    `output.search: ${config.output.search.mode}, collapsed=${formatBoolean(config.output.search.collapsed)}, previewLines=${config.output.search.previewLines}`,
    `output.bash: ${config.output.bash.mode}, collapsed=${formatBoolean(config.output.bash.collapsed)}, previewLines=${config.output.bash.previewLines}, rtkHints=${formatBoolean(config.output.bash.rtkHints)}`,
    `diff: enabled=${formatBoolean(config.diff.enabled)}, collapsed=${formatBoolean(config.diff.collapsed)}, previewLines=${config.diff.previewLines}`,
  ].join("\n");
}

function buildHelpMessage(): string {
  return [
    "Usage: /tool-display <command>",
    "show             Show resolved config",
    "preset compact   Write compact defaults to .pi/tool-display.json",
    "preset verbose   Write expanded preview config to .pi/tool-display.json",
    "preset off       Disable tool-display tool overrides in project config",
    "reset            Write default project config",
    "help             Show this help",
  ].join("\n");
}

function getToolDisplayArgumentCompletions(argumentPrefix: string) {
  const hasTrailingSpace = TRAILING_SPACE_REGEX.test(argumentPrefix);
  const trimmedStart = argumentPrefix.trimStart();

  if (trimmedStart.length === 0) {
    return TOOL_DISPLAY_SUBCOMMANDS.map(({ value, description }) => ({
      value,
      label: value,
      description,
    }));
  }

  const parts = trimmedStart.split(SPLIT_REGEX);
  const subcommand = parts[0] ?? "";
  const nextToken = parts[1] ?? "";
  const hasExtraTokens = parts.length > 2;

  if (subcommand === "preset" && (hasTrailingSpace || nextToken.length > 0)) {
    if (hasExtraTokens || (hasTrailingSpace && nextToken.length > 0)) {
      return null;
    }

    const presets = TOOL_DISPLAY_PRESETS.filter(({ value }) =>
      value.startsWith(nextToken)
    );
    return presets.length > 0
      ? presets.map(({ value, description }) => ({
          value: `preset ${value}`,
          label: value,
          description,
        }))
      : null;
  }

  const subcommands = TOOL_DISPLAY_SUBCOMMANDS.filter(({ value }) =>
    value.startsWith(subcommand)
  );
  return subcommands.length > 0
    ? subcommands.map(({ value, description }) => ({
        value,
        label: value,
        description,
      }))
    : null;
}

function notifyWriteResult(
  ctx: ExtensionCommandContext,
  result:
    | { ok: true; configPath: string; config: ToolDisplayConfig }
    | { ok: false; configPath: string; error: string },
  successMessage: string
): void {
  if (result.ok) {
    ctx.ui.notify(`${successMessage}: ${result.configPath}`, "info");
    return;
  }
  ctx.ui.notify(`tool-display config write failed: ${result.error}`, "warning");
}

export function registerToolDisplayCommands(pi: ExtensionAPI): void {
  pi.registerCommand("tool-display", {
    description: "Manage tool-display settings",
    getArgumentCompletions: getToolDisplayArgumentCompletions,
    handler: (args, ctx) => {
      const [command = "show", ...rest] = args
        .trim()
        .split(SPLIT_REGEX)
        .filter(Boolean);

      switch (command) {
        case "show": {
          ctx.ui.notify(buildShowMessage(ctx), "info");
          return;
        }
        case "preset": {
          const preset = rest[0];
          if (!isToolDisplayPresetName(preset)) {
            ctx.ui.notify(
              "Usage: /tool-display preset <compact|verbose|off>",
              "warning"
            );
            return;
          }

          notifyWriteResult(
            ctx,
            writeProjectToolDisplayConfig(
              ctx.cwd,
              getToolDisplayPresetConfig(preset)
            ),
            `tool-display ${preset} preset written`
          );
          return;
        }
        case "reset": {
          notifyWriteResult(
            ctx,
            resetProjectToolDisplayConfig(ctx.cwd),
            "tool-display defaults written"
          );
          return;
        }
        default: {
          if (command !== "help") {
            ctx.ui.notify(
              `Unknown /tool-display command: ${command}`,
              "warning"
            );
          }
          ctx.ui.notify(buildHelpMessage(), "info");
        }
      }
    },
  });
}
