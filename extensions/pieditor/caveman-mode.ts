import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

export const CAVEMAN_MODE_CUSTOM_TYPE = "pieditor:caveman-mode";
export const CAVEMAN_MODE_STATUS_KEY = "pieditor-caveman";
export const CAVEMAN_MODE_STATUS_TEXT = "🪨 caveman";

export const CAVEMAN_MODE_PROMPT = `CAVEMAN MODE ACTIVE:
- Answer user in short caveman-style phrases.
- Keep code, commands, paths, JSON, and tool arguments exact; do not caveman-translate them.
- Still follow all higher-priority instructions and complete the task normally.`;

interface CavemanModeState {
  enabled: boolean;
}

let cavemanModeEnabled = false;

export function isCavemanModeEnabled(): boolean {
  return cavemanModeEnabled;
}

interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

const CAVEMAN_MODE_COMPLETIONS = [
  {
    value: "on",
    label: "on",
    description: "Enable caveman mode",
  },
  {
    value: "off",
    label: "off",
    description: "Disable caveman mode",
  },
  {
    value: "status",
    label: "status",
    description: "Show caveman mode status",
  },
  {
    value: "toggle",
    label: "toggle",
    description: "Toggle caveman mode",
  },
];

function parseCavemanModeState(data: unknown): CavemanModeState | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const state = data as { enabled?: unknown };
  if (typeof state.enabled !== "boolean") {
    return null;
  }

  return { enabled: state.enabled };
}

function getLatestCavemanModeState(
  entries: readonly SessionEntryLike[]
): CavemanModeState | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry?.type === "custom" &&
      entry.customType === CAVEMAN_MODE_CUSTOM_TYPE
    ) {
      const state = parseCavemanModeState(entry.data);
      if (state) {
        return state;
      }
    }
  }

  return null;
}

function refreshCavemanStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) {
    return;
  }

  ctx.ui.setStatus(CAVEMAN_MODE_STATUS_KEY, undefined);
}

function describeCavemanModeStatus(enabled: boolean): string {
  return `Caveman mode ${enabled ? "enabled" : "disabled"}`;
}

function notifyCavemanModeStatus(
  ctx: ExtensionCommandContext,
  enabled: boolean
): void {
  ctx.ui.notify(describeCavemanModeStatus(enabled), "info");
}

export function registerCavemanMode(pi: ExtensionAPI): void {
  cavemanModeEnabled = false;

  const setEnabled = (
    ctx: ExtensionContext,
    nextEnabled: boolean,
    persist: boolean
  ): void => {
    cavemanModeEnabled = nextEnabled;

    if (persist) {
      pi.appendEntry(CAVEMAN_MODE_CUSTOM_TYPE, {
        enabled: nextEnabled,
      });
    }

    refreshCavemanStatus(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    const state = getLatestCavemanModeState(
      ctx.sessionManager.getEntries() as readonly SessionEntryLike[]
    );
    setEnabled(ctx, state?.enabled ?? false, false);
  });

  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    if (!cavemanModeEnabled) {
      return undefined;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${CAVEMAN_MODE_PROMPT}`,
    };
  });

  pi.registerCommand("caveman", {
    description: "Toggle pieditor caveman mode: /caveman [on|off|status]",
    getArgumentCompletions(argumentPrefix) {
      const prefix = argumentPrefix.trim().toLowerCase();
      return CAVEMAN_MODE_COMPLETIONS.filter((completion) =>
        completion.value.startsWith(prefix)
      );
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = args.trim().toLowerCase().split(/\s+/)[0] || "toggle";

      switch (command) {
        case "on": {
          setEnabled(ctx, true, true);
          notifyCavemanModeStatus(ctx, true);
          return;
        }

        case "off": {
          setEnabled(ctx, false, true);
          notifyCavemanModeStatus(ctx, false);
          return;
        }

        case "status": {
          refreshCavemanStatus(ctx);
          notifyCavemanModeStatus(ctx, cavemanModeEnabled);
          return;
        }

        case "toggle": {
          const nextEnabled = !cavemanModeEnabled;
          setEnabled(ctx, nextEnabled, true);
          notifyCavemanModeStatus(ctx, nextEnabled);
          return;
        }

        default: {
          ctx.ui.notify("Usage: /caveman [on|off|status]", "warning");
        }
      }
    },
  });
}
