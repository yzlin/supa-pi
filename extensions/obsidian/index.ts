import { resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import { type LoadedConfig, loadObsidianConfig } from "./config";
import {
  discoverContextChain,
  type LoadedContextState,
  loadContextFiles,
  persistLoadedPaths,
  stateFromSession,
} from "./context";
import { type ActiveVault, assertContained, resolveActiveVault } from "./vault";

const GUARDED_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

function targetPathFor(event: ToolCallEvent, cwd: string): string | null {
  if (!GUARDED_TOOLS.has(event.toolName)) {
    return null;
  }
  const input = event.input as { path?: unknown };
  return typeof input.path === "string" ? resolve(cwd, input.path) : cwd;
}

function getRuntime(ctx: ExtensionContext): {
  config: LoadedConfig;
  active: ActiveVault | null;
  state: LoadedContextState;
} {
  const config = loadObsidianConfig();
  return {
    config,
    active: config.enabled ? resolveActiveVault(ctx.cwd, config.vaults) : null,
    state: stateFromSession(ctx),
  };
}

function buildObsidianPrompt(paths: string[]): string {
  return `Obsidian vault context loaded from context files. Follow these instructions in parent-to-child order.\n\n${loadContextFiles(paths)}`;
}

function activeContextPaths(
  active: ActiveVault,
  state: LoadedContextState,
): string[] {
  return [...state.paths].filter((item) => assertContained(active.vault, item));
}

function addMissingContext(
  pi: ExtensionAPI,
  active: ActiveVault,
  state: LoadedContextState,
  targetPath: string,
): string[] {
  const chain = discoverContextChain(active.vault, targetPath, state.paths);
  const missing = chain.filter((item) => !state.paths.has(item));
  if (missing.length === 0) {
    return [];
  }

  loadContextFiles([...activeContextPaths(active, state), ...missing]);
  for (const item of missing) {
    state.paths.add(item);
  }
  persistLoadedPaths(pi, state);
  return missing;
}

export default function obsidianExtension(pi: ExtensionAPI): void {
  // A section, not a provider payload patch: claude-bridge never runs
  // before_provider_request, and payload shapes differ per provider.
  pi.on("before_agent_start", (event, ctx) => {
    const { active, state } = getRuntime(ctx);
    if (!active) {
      return;
    }

    addMissingContext(pi, active, state, ctx.cwd);
    const paths = activeContextPaths(active, state);
    if (paths.length > 0) {
      event.systemPromptOptions.sections.obsidian_context =
        buildObsidianPrompt(paths);
    }
  });

  pi.on("tool_call", (event, ctx) => {
    const { active, state } = getRuntime(ctx);
    if (!active) {
      return;
    }

    const targetPath = targetPathFor(event, ctx.cwd);
    if (!targetPath) {
      return;
    }
    if (!assertContained(active.vault, targetPath)) {
      return {
        block: true,
        reason: "Obsidian guard blocked path outside the active vault.",
      };
    }

    try {
      const missing = addMissingContext(pi, active, state, targetPath);
      if (missing.length === 0) {
        return;
      }

      // Sections change only at run start, so deliver mid-run context in the
      // block reason; the next run's section includes it.
      return {
        block: true,
        reason: `Obsidian loaded missing context for ${targetPath}. Follow these instructions in parent-to-child order, then retry the same structured tool call.\n\n${loadContextFiles(missing)}`,
      };
    } catch (error) {
      return {
        block: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  pi.registerCommand("obsidian", {
    description: "Show Obsidian extension status",
    getArgumentCompletions(argumentPrefix) {
      const trimmed = argumentPrefix.trimStart();
      return "status".startsWith(trimmed)
        ? [{ value: "status", label: "status" }]
        : null;
    },
    handler: (args, ctx) => {
      const command = args.trim();
      if (command !== "" && command !== "status") {
        ctx.ui.notify("Usage: /obsidian status", "warning");
        return Promise.resolve();
      }
      const { config, active, state } = getRuntime(ctx);
      const loadedPaths = [...state.paths].sort();
      const warnings = [...config.warnings, ...(active?.warnings ?? [])];
      const text = [
        `enabled: ${config.enabled}`,
        `configured vaults: ${config.vaults.length}`,
        `active vault: ${active?.vault.name ?? active?.vault.path ?? "none"}`,
        `loaded context paths: ${loadedPaths.length}`,
        ...loadedPaths.map((path) => `  - ${path}`),
        ...warnings.map((warning) => `warning: ${warning}`),
      ].join("\n");
      ctx.ui.notify(text, "info");
      return Promise.resolve();
    },
  });
}
