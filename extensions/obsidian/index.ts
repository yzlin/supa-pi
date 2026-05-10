import { resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import { type LoadedConfig, loadObsidianConfig } from "./config";
import {
  discoverClaudeChain,
  type LoadedContextState,
  loadContextFiles,
  persistLoadedPaths,
  stateFromSession,
} from "./context";
import { type ActiveVault, assertContained, resolveActiveVault } from "./vault";

const GUARDED_TOOLS = new Set([
  "ast_grep",
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

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
  return `Obsidian vault context loaded from CLAUDE.md files. Follow these instructions in parent-to-child order.\n\n${loadContextFiles(paths)}`;
}

function activeContextPaths(
  active: ActiveVault,
  state: LoadedContextState
): string[] {
  return [...state.paths].filter((item) => assertContained(active.vault, item));
}

function addMissingContext(
  pi: ExtensionAPI,
  active: ActiveVault,
  state: LoadedContextState,
  targetPath: string
): string[] {
  const chain = discoverClaudeChain(active.vault, targetPath);
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

function appendObsidianPrompt(
  systemPrompt: string,
  contextPrompt: string
): string {
  return `${systemPrompt}\n\n${contextPrompt}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isTextSystemBlock(
  block: unknown
): block is Record<string, unknown> & { text: string; type: "text" } {
  return (
    isRecord(block) && block.type === "text" && typeof block.text === "string"
  );
}

function isSystemMessage(
  message: unknown
): message is Record<string, unknown> & { content: string; role: "system" } {
  return (
    isRecord(message) &&
    message.role === "system" &&
    typeof message.content === "string"
  );
}

function appendToAnthropicSystemBlock(
  block: unknown,
  contextPrompt: string
): unknown {
  if (!isTextSystemBlock(block)) {
    return block;
  }

  return {
    ...block,
    text: appendObsidianPrompt(block.text, contextPrompt),
  };
}

function appendToProviderPayload(
  payload: unknown,
  contextPrompt: string
): unknown | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  if (typeof payload.system === "string") {
    return {
      ...payload,
      system: appendObsidianPrompt(payload.system, contextPrompt),
    };
  }
  if (Array.isArray(payload.system)) {
    const lastTextIndex = payload.system.findLastIndex(isTextSystemBlock);
    if (lastTextIndex >= 0) {
      return {
        ...payload,
        system: payload.system.map((item, index) =>
          index === lastTextIndex
            ? appendToAnthropicSystemBlock(item, contextPrompt)
            : item
        ),
      };
    }
  }
  if (typeof payload.systemPrompt === "string") {
    return {
      ...payload,
      systemPrompt: appendObsidianPrompt(payload.systemPrompt, contextPrompt),
    };
  }
  if (Array.isArray(payload.messages)) {
    const messages = payload.messages;
    const first = messages[0];
    if (isSystemMessage(first)) {
      return {
        ...payload,
        messages: [
          {
            ...first,
            content: appendObsidianPrompt(first.content, contextPrompt),
          },
          ...messages.slice(1),
        ],
      };
    }
  }

  return undefined;
}

export default function obsidianExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (_event, ctx) => {
    const { active, state } = getRuntime(ctx);
    if (!active) {
      return;
    }

    addMissingContext(pi, active, state, ctx.cwd);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const { active, state } = getRuntime(ctx);
    if (!active) {
      return;
    }

    const paths = activeContextPaths(active, state);
    if (paths.length === 0) {
      return;
    }

    return appendToProviderPayload(event.payload, buildObsidianPrompt(paths));
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

      return {
        block: true,
        reason: `Obsidian loaded missing CLAUDE context for ${targetPath}. Retry the same structured tool call now.`,
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
        `loaded CLAUDE paths: ${loadedPaths.length}`,
        ...loadedPaths.map((path) => `  - ${path}`),
        ...warnings.map((warning) => `warning: ${warning}`),
      ].join("\n");
      ctx.ui.notify(text, "info");
      return Promise.resolve();
    },
  });
}
