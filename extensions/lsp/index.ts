/**
 * Pi LSP Extension
 *
 * Language-agnostic code intelligence via LSP.
 * Auto-detects servers by file extension, configurable via:
 *   - ~/.pi/agent/lsp.json  (global defaults)
 *   - .pi/lsp.json          (project overrides)
 *
 * Any LSP server can be added via config.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

import { LspClient } from "./client";
import {
  type CommandAvailabilityCache,
  type LoadedConfig,
  loadConfig,
  resolveConfiguredServer,
  scaffoldGlobalConfig,
  serversForExtension,
} from "./config";
import { fg, padVisibleText, paletteTheme } from "./theme.js";
import { registerLspTool, type ServerManager } from "./tools";
import type { ConfiguredServerConfig, ResolvedServerConfig } from "./types";

const LSP_SUBCOMMANDS = [
  {
    value: "status",
    description: "Show LSP server status",
  },
  {
    value: "restart",
    description: "Restart all LSP servers",
  },
  {
    value: "help",
    description: "Show LSP command help",
  },
] as const;

function getLspArgumentCompletions(argumentPrefix: string) {
  const trimmed = argumentPrefix.trim();
  if (!trimmed) {
    return LSP_SUBCOMMANDS.map(({ value, description }) => ({
      value,
      label: value,
      description,
    }));
  }

  if (trimmed.includes(" ")) {
    return null;
  }

  const matches = LSP_SUBCOMMANDS.filter(({ value }) =>
    value.startsWith(trimmed)
  );
  return matches.length > 0
    ? matches.map(({ value, description }) => ({
        value,
        label: value,
        description,
      }))
    : null;
}

const TEXT_MODAL_MIN_WIDTH = 36;
const STATUS_MODAL_MIN_WIDTH = 56;
const STATUS_MODAL_HELP = "enter/esc/q close";

type LspThemeTone =
  | "accent"
  | "success"
  | "warning"
  | "dim"
  | "toolTitle";

type ThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type FramePalette = {
  border(text: string): string;
  title(text: string): string;
};

const DEFAULT_FRAME_PALETTE: FramePalette = {
  border(text: string): string {
    return fg(paletteTheme.border, text);
  },
  title(text: string): string {
    return fg(paletteTheme.title, text);
  },
};

function getThemeFramePalette(theme: Pick<ThemeLike, "fg">): FramePalette {
  return {
    border(text: string): string {
      return theme.fg("border", text);
    },
    title(text: string): string {
      return theme.fg("border", text);
    },
  };
}

interface LspStatusServerView {
  name: string;
  statusLabel: string;
  statusTone: "success" | "accent";
  extensionsLabel: string;
  commandLabel: string;
}

function buildLspHelpMessage(): string {
  return [
    "LSP commands:",
    "  /lsp           Show LSP server status",
    "  /lsp status    Show LSP server status",
    "  /lsp restart   Restart all LSP servers",
    "  /lsp help      Show this help",
    "",
    "Close: esc, enter, or q",
  ].join("\n");
}

function border(
  width: number,
  left: string,
  fill: string,
  right: string,
  framePalette: FramePalette = DEFAULT_FRAME_PALETTE
): string {
  return framePalette.border(
    `${left}${fill.repeat(Math.max(0, width - 2))}${right}`
  );
}

function titleBorder(
  width: number,
  titleText: string,
  framePalette: FramePalette = DEFAULT_FRAME_PALETTE
): string {
  const innerWidth = Math.max(0, width - 2);
  const clippedTitle = truncateToWidth(titleText, innerWidth);
  const borderWidth = Math.max(0, innerWidth - visibleWidth(clippedTitle));
  const leftWidth = Math.floor(borderWidth / 2);
  const rightWidth = borderWidth - leftWidth;

  return (
    framePalette.border(`╭${"─".repeat(leftWidth)}`) +
    framePalette.title(clippedTitle) +
    framePalette.border(`${"─".repeat(rightWidth)}╮`)
  );
}

function frameLine(
  content: string,
  width: number,
  framePalette: FramePalette = DEFAULT_FRAME_PALETTE
): string {
  const innerWidth = Math.max(0, width - 2);
  const clipped = truncateToWidth(` ${content} `, innerWidth);
  return `${framePalette.border("│")}${padVisibleText(clipped, innerWidth)}${framePalette.border("│")}`;
}

function centerText(content: string, width: number): string {
  const clipped = truncateToWidth(content, width);
  const remaining = Math.max(0, width - visibleWidth(clipped));
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${" ".repeat(left)}${clipped}${" ".repeat(right)}`;
}

function wrapLines(lines: string[], width: number): string[] {
  return lines.flatMap((line) => {
    if (!line) {
      return [""];
    }

    return wrapTextWithAnsi(line, width).map((item) =>
      truncateToWidth(item, width)
    );
  });
}

function buildLspStatusLines(
  cfg: LoadedConfig,
  clients: Map<string, LspClient>
): string[] {
  const lines: string[] = ["LSP Status:"];

  if (cfg.globalDisabled) {
    lines.push("  All servers disabled via config.");
  } else if (cfg.servers.length === 0) {
    lines.push("  No servers configured.");
    lines.push("  Add servers to ~/.pi/agent/lsp.json or .pi/lsp.json");
  } else {
    for (const server of cfg.servers) {
      const client = clients.get(server.name);
      const status = client?.isInitialized
        ? "running"
        : "configured (lazy probe)";
      const exts = server.extensions.join(", ");
      lines.push(`  ${server.name}: ${status} — handles ${exts}`);
    }
  }

  if (cfg.errors.length > 0) {
    lines.push("", "Config errors:");
    for (const err of cfg.errors) {
      lines.push(`  - ${err}`);
    }
  }

  return lines;
}

function buildLspStatusServers(
  cfg: LoadedConfig,
  clients: Map<string, LspClient>
): LspStatusServerView[] {
  return cfg.servers.map((server) => {
    const client = clients.get(server.name);
    const isRunning = client?.isInitialized ?? false;

    return {
      name: server.name,
      statusLabel: isRunning ? "running" : "lazy probe",
      statusTone: isRunning ? "success" : "accent",
      extensionsLabel:
        server.extensions.length > 0 ? server.extensions.join(", ") : "none",
      commandLabel: server.command.join(" "),
    };
  });
}

function renderSummaryMetric(
  theme: ThemeLike,
  label: string,
  value: number,
  tone: LspThemeTone
): string {
  return `${theme.fg(tone, "■")} ${label} ${theme.bold(String(value))}`;
}

function shouldCloseOverlay(data: string): boolean {
  return (
    matchesKey(data, Key.escape) ||
    matchesKey(data, Key.enter) ||
    data.toLowerCase() === "q"
  );
}

function buildStatusSummaryLine(
  theme: ThemeLike,
  servers: LspStatusServerView[],
  errorCount: number
): string {
  const runningCount = servers.filter(
    (server) => server.statusLabel === "running"
  ).length;
  const lazyCount = servers.length - runningCount;

  return [
    renderSummaryMetric(theme, "configured", servers.length, "accent"),
    renderSummaryMetric(
      theme,
      "running",
      runningCount,
      runningCount > 0 ? "success" : "dim"
    ),
    renderSummaryMetric(
      theme,
      "lazy",
      lazyCount,
      lazyCount > 0 ? "accent" : "dim"
    ),
    renderSummaryMetric(
      theme,
      "errors",
      errorCount,
      errorCount > 0 ? "warning" : "dim"
    ),
  ].join(` ${theme.fg("dim", "·")} `);
}

function buildStatusBodyLines(
  theme: ThemeLike,
  cfg: LoadedConfig,
  servers: LspStatusServerView[]
): string[] {
  const bodyLines: string[] = [];

  if (cfg.globalDisabled) {
    bodyLines.push(theme.bold(theme.fg("toolTitle", "Status")));
    bodyLines.push(theme.fg("warning", "All servers disabled via config."));
    bodyLines.push(
      theme.fg(
        "dim",
        "Set `lsp` to an object in ~/.pi/agent/lsp.json or .pi/lsp.json to re-enable LSP."
      )
    );
  } else if (servers.length === 0) {
    bodyLines.push(theme.bold(theme.fg("toolTitle", "Status")));
    bodyLines.push(theme.fg("warning", "No servers configured."));
    bodyLines.push(
      theme.fg("dim", "Add servers to ~/.pi/agent/lsp.json or .pi/lsp.json.")
    );
  } else {
    bodyLines.push(theme.bold(theme.fg("toolTitle", "Servers")));
    for (const server of servers) {
      bodyLines.push(
        `${theme.fg(server.statusTone, "●")} ${theme.bold(server.name)} ${theme.fg("dim", "·")} ${theme.fg(server.statusTone, server.statusLabel)} ${theme.fg("dim", "· handles")} ${server.extensionsLabel}`
      );
      bodyLines.push(
        `${theme.fg("dim", "    command")} ${server.commandLabel}`
      );
    }
  }

  if (cfg.errors.length > 0) {
    if (bodyLines.length > 0) {
      bodyLines.push("");
    }
    bodyLines.push(theme.bold(theme.fg("warning", "Config errors")));
    for (const err of cfg.errors) {
      bodyLines.push(`${theme.fg("warning", "!")} ${err}`);
    }
  }

  return bodyLines;
}

async function showLspTextView(
  ctx: ExtensionCommandContext,
  text: string,
  level: "info" | "warning" = "info"
): Promise<void> {
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
    ctx.ui.notify(text, level);
    return;
  }

  await ctx.ui.custom<void>(
    (_tui, theme, _kb, done) => {
      const framePalette = getThemeFramePalette(theme);

      return {
        invalidate() {},
        render(width: number) {
          const frameWidth = Math.max(TEXT_MODAL_MIN_WIDTH, width);
          const innerWidth = Math.max(8, frameWidth - 4);
          const bodyLines = wrapLines(text.split("\n"), innerWidth);

          return [
            titleBorder(frameWidth, " LSP ", framePalette),
            border(frameWidth, "├", "─", "┤", framePalette),
            ...bodyLines.map((line) =>
              frameLine(line, frameWidth, framePalette)
            ),
            border(frameWidth, "╰", "─", "╯", framePalette),
          ];
        },
        handleInput(data: string) {
          if (shouldCloseOverlay(data)) {
            done(undefined);
          }
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "70%",
        minWidth: TEXT_MODAL_MIN_WIDTH,
        maxHeight: "80%",
        margin: 1,
      },
    }
  );
}

async function showLspStatusView(
  ctx: ExtensionCommandContext,
  cfg: LoadedConfig,
  clients: Map<string, LspClient>
): Promise<void> {
  const fallbackText = buildLspStatusLines(cfg, clients).join("\n");
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
    ctx.ui.notify(fallbackText, "info");
    return;
  }

  const servers = buildLspStatusServers(cfg, clients);

  await ctx.ui.custom<void>(
    (_tui, theme, _kb, done) => {
      const framePalette = getThemeFramePalette(theme);

      return {
        invalidate() {},
        render(width: number) {
          const frameWidth = Math.max(STATUS_MODAL_MIN_WIDTH, width);
          const innerWidth = Math.max(8, frameWidth - 4);
          const summaryLine = buildStatusSummaryLine(
            theme,
            servers,
            cfg.errors.length
          );
          const wrappedBody = wrapLines(
            buildStatusBodyLines(theme, cfg, servers),
            innerWidth
          );

          return [
            titleBorder(
              frameWidth,
              " Language Server Protocol ",
              framePalette
            ),
            frameLine(
              centerText(
                theme.fg("dim", "Per-workspace routing · lazy server startup"),
                innerWidth
              ),
              frameWidth,
              framePalette
            ),
            border(frameWidth, "├", "─", "┤", framePalette),
            frameLine(summaryLine, frameWidth, framePalette),
            border(frameWidth, "├", "─", "┤", framePalette),
            ...wrappedBody.map((line) =>
              frameLine(line, frameWidth, framePalette)
            ),
            border(frameWidth, "├", "─", "┤", framePalette),
            frameLine(
              centerText(theme.fg("dim", STATUS_MODAL_HELP), innerWidth),
              frameWidth,
              framePalette
            ),
            border(frameWidth, "╰", "─", "╯", framePalette),
          ];
        },
        handleInput(data: string) {
          if (shouldCloseOverlay(data)) {
            done(undefined);
          }
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "72%",
        minWidth: STATUS_MODAL_MIN_WIDTH,
        maxHeight: "80%",
        margin: 1,
      },
    }
  );
}

export default function lspExtension(pi: ExtensionAPI) {
  let rootPath = "";
  let config: LoadedConfig | null = null;
  const clients = new Map<string, LspClient>();
  const commandAvailabilityCache: CommandAvailabilityCache = new Map();

  // ── Client management ───────────────────────────────────────────────

  function resolveServer(
    serverConfig: ConfiguredServerConfig
  ): ResolvedServerConfig | null {
    return resolveConfiguredServer(
      serverConfig,
      rootPath,
      commandAvailabilityCache
    );
  }

  function resolveMatchingServers(filePath: string): ResolvedServerConfig[] {
    if (!config) return [];
    return serversForExtension(config.servers, filePath)
      .map((serverConfig) => resolveServer(serverConfig))
      .filter((server): server is ResolvedServerConfig => server !== null);
  }

  function getOrCreateClient(serverConfig: ResolvedServerConfig): LspClient {
    const existing = clients.get(serverConfig.name);
    if (existing) return existing;

    const client = new LspClient(serverConfig, rootPath);
    clients.set(serverConfig.name, client);
    return client;
  }

  async function shutdownAll(): Promise<void> {
    const shutdowns = [...clients.values()].map((c) =>
      c.shutdown().catch(() => {})
    );
    await Promise.all(shutdowns);
    clients.clear();
    commandAvailabilityCache.clear();
  }

  function refreshStatus(
    ui: { setStatus: (key: string, value: string) => void },
    cfg: LoadedConfig | null
  ) {
    if (!cfg) {
      ui.setStatus("lsp", "LSP: no servers detected");
      return;
    }

    if (cfg.globalDisabled) {
      ui.setStatus("lsp", "LSP: disabled");
      return;
    }

    if (cfg.servers.length === 0) {
      ui.setStatus("lsp", "LSP: no servers detected");
      return;
    }

    const running = cfg.servers.filter(
      (server) => clients.get(server.name)?.isInitialized
    );
    if (running.length > 0) {
      ui.setStatus(
        "lsp",
        `LSP: ${running.map((s) => s.name).join(", ")} (running)`
      );
      return;
    }

    ui.setStatus("lsp", `LSP: ${cfg.servers.map((s) => s.name).join(", ")}`);
  }

  // ── Server manager (passed to tool) ───────────────────────────────────

  const serverManager: ServerManager = {
    clientsForFile(filePath: string): LspClient[] {
      if (!config) return [];
      return resolveMatchingServers(filePath).map((s) => getOrCreateClient(s));
    },

    clientForFileWithCapability(
      filePath: string,
      capability: string
    ): LspClient | null {
      if (!config) return null;
      const matching = resolveMatchingServers(filePath);
      for (const serverConfig of matching) {
        const client = getOrCreateClient(serverConfig);
        // If not yet initialized, return it (capability check happens after init)
        if (!client.isInitialized) return client;
        if (client.hasCapability(capability)) return client;
      }
      return null;
    },

    anyClient(): LspClient | null {
      // Return first initialized client, or first available
      for (const client of clients.values()) {
        if (client.isInitialized) return client;
      }
      // Try to create one from the first resolvable configured server
      if (config) {
        for (const serverConfig of config.servers) {
          const resolved = resolveServer(serverConfig);
          if (resolved) return getOrCreateClient(resolved);
        }
      }
      return null;
    },

    getRootPath: () => rootPath,
  };

  // ── Register tool ─────────────────────────────────────────────────────

  registerLspTool(pi, serverManager);

  // ── Session lifecycle ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    rootPath = ctx.cwd;
    commandAvailabilityCache.clear();

    const scaffolded = await scaffoldGlobalConfig(rootPath);
    if (scaffolded) {
      ctx.ui.notify(
        "LSP: created starter config at ~/.pi/agent/lsp.json — edit it to add your servers.",
        "info"
      );
    }

    config = await loadConfig(rootPath);
    refreshStatus(ctx.ui, config);
  });

  pi.on("session_shutdown", async () => {
    await shutdownAll();
    config = null;
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "lsp") return;
    refreshStatus(ctx.ui, config);
  });

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("lsp", {
    description: "Manage LSP server status and lifecycle",
    getArgumentCompletions: getLspArgumentCompletions,
    handler: async (args, ctx) => {
      const [subcommand = "status"] = args.trim().split(/\s+/).filter(Boolean);

      switch (subcommand) {
        case "status": {
          rootPath = ctx.cwd;
          const cfg = await loadConfig(ctx.cwd);
          config = cfg;
          refreshStatus(ctx.ui, cfg);
          await showLspStatusView(ctx, cfg, clients);
          return;
        }

        case "restart": {
          await shutdownAll();
          config = null;
          rootPath = ctx.cwd;
          config = await loadConfig(ctx.cwd);
          refreshStatus(ctx.ui, config);
          ctx.ui.notify(
            "LSP servers stopped. Will reinitialize on next tool use.",
            "info"
          );
          return;
        }

        case "help": {
          await showLspTextView(ctx, buildLspHelpMessage());
          return;
        }

        default: {
          ctx.ui.notify(`Unknown /lsp subcommand: ${subcommand}`, "warning");
          await showLspTextView(ctx, buildLspHelpMessage());
        }
      }
    },
  });
}
