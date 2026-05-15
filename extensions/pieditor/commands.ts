import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
  type FixedEditorRuntimeConfig,
  hasProjectFixedEditorEnabledOverride,
  saveGlobalFixedEditorEnabled,
} from "./config.js";
import {
  getActiveReplacementLeaseDiagnostics,
  hasReplacementLeaseCompositor,
} from "./fixed-editor/replacement-lease.js";

interface FixedEditorRuntimeHooks {
  getFixedEditorConfig(): FixedEditorRuntimeConfig;
  setFixedEditorEnabled(enabled: boolean): void;
}

interface PieditorCommandOptions {
  homeDir?: string;
}

const COMMAND_PARTS_PATTERN = /\s+/;
const FIXED_EDITOR_USAGE =
  "Usage: /pieditor fixed-editor [on|off|toggle|status]";

const PIEDITOR_COMPLETIONS = [
  {
    value: "fixed-editor",
    label: "fixed-editor",
    description: "Manage fixed editor mode",
  },
  {
    value: "fixed-editor on",
    label: "fixed-editor on",
    description: "Enable fixed editor mode",
  },
  {
    value: "fixed-editor off",
    label: "fixed-editor off",
    description: "Disable fixed editor mode",
  },
  {
    value: "fixed-editor toggle",
    label: "fixed-editor toggle",
    description: "Toggle fixed editor mode",
  },
  {
    value: "fixed-editor status",
    label: "fixed-editor status",
    description: "Show fixed editor mode status",
  },
];

function describeFixedEditorStatus(enabled: boolean): string {
  return `pieditor fixed-editor ${enabled ? "enabled" : "disabled"}`;
}

function describeReplacementLeaseStatus(): string {
  const prefix = `replacement compositor: ${
    hasReplacementLeaseCompositor() ? "attached" : "detached"
  }; replacement leases`;
  const leases = getActiveReplacementLeaseDiagnostics();
  if (leases.length === 0) {
    return `${prefix}: 0`;
  }

  const owners = [...new Set(leases.map((lease) => lease.owner))].join(", ");
  return `${prefix}: ${leases.length} (${owners})`;
}

function notifyProjectOverride(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(
    "Project .pi/pieditor.json overrides fixedEditor.enabled; global save will not affect next load in this project.",
    "warning"
  );
}

function getCommandCwd(ctx: ExtensionCommandContext): string {
  return typeof ctx.cwd === "string" && ctx.cwd.length > 0
    ? ctx.cwd
    : process.cwd();
}

function parsePieditorCommand(args: string): {
  topic: string;
  action: string;
} {
  const [topic = "", action = "status"] = args
    .trim()
    .toLowerCase()
    .split(COMMAND_PARTS_PATTERN);
  return { topic, action };
}

function getNextFixedEditorEnabled(
  action: string,
  currentEnabled: boolean
): boolean | null {
  switch (action) {
    case "on":
      return true;
    case "off":
      return false;
    case "toggle":
      return !currentEnabled;
    default:
      return null;
  }
}

function handleFixedEditorCommand(
  action: string,
  ctx: ExtensionCommandContext,
  runtime: FixedEditorRuntimeHooks,
  options: PieditorCommandOptions = {}
): void {
  if (action === "status") {
    const projectOverride = hasProjectFixedEditorEnabledOverride({
      cwd: getCommandCwd(ctx),
    });
    ctx.ui.notify(
      `${describeFixedEditorStatus(runtime.getFixedEditorConfig().enabled)}${
        projectOverride ? " (project override active)" : ""
      }; ${describeReplacementLeaseStatus()}`,
      "info"
    );
    return;
  }

  const currentEnabled = runtime.getFixedEditorConfig().enabled;
  const nextEnabled = getNextFixedEditorEnabled(action, currentEnabled);

  if (nextEnabled === null) {
    ctx.ui.notify(FIXED_EDITOR_USAGE, "warning");
    return;
  }

  const cwd = getCommandCwd(ctx);
  const projectOverride = hasProjectFixedEditorEnabledOverride({ cwd });
  runtime.setFixedEditorEnabled(nextEnabled);

  const result = saveGlobalFixedEditorEnabled(nextEnabled, {
    cwd,
    homeDir: options.homeDir,
  });

  if (!result.ok) {
    ctx.ui.notify(
      `${describeFixedEditorStatus(nextEnabled)} (live only; not saved: ${result.error})`,
      "error"
    );
    return;
  }

  ctx.ui.notify(`${describeFixedEditorStatus(nextEnabled)} (saved)`, "info");

  if (projectOverride) {
    notifyProjectOverride(ctx);
  }
}

export function registerPieditorCommands(
  pi: ExtensionAPI,
  runtime: FixedEditorRuntimeHooks,
  options: PieditorCommandOptions = {}
): void {
  pi.registerCommand("pieditor", {
    description:
      "Manage pieditor runtime settings: /pieditor fixed-editor [on|off|toggle|status]",
    getArgumentCompletions(argumentPrefix) {
      const prefix = argumentPrefix.trim().toLowerCase();
      return PIEDITOR_COMPLETIONS.filter((completion) =>
        completion.value.startsWith(prefix)
      );
    },
    handler: (args: string, ctx: ExtensionCommandContext) => {
      const { topic, action } = parsePieditorCommand(args);

      if (topic !== "fixed-editor") {
        ctx.ui.notify(FIXED_EDITOR_USAGE, "warning");
        return;
      }

      handleFixedEditorCommand(action, ctx, runtime, options);
    },
  });
}
