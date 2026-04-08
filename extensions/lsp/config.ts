/**
 * LSP server configuration loader.
 *
 * Purely config-driven — no built-in servers. Users define all servers
 * in their config files:
 *
 *   ~/.pi/agent/lsp.json  (global defaults)
 *   .pi/lsp.json          (project overrides)
 *
 * Project config merges on top of global. `disabled: true` disables a server.
 * `lsp: false` disables all LSP functionality.
 */

import { execSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  ConfiguredServerConfig,
  LspConfigFile,
  LspServerUserConfig,
  ResolvedServerConfig,
} from "./types";

// ── Paths ───────────────────────────────────────────────────────────────────

function globalConfigPath(): string {
  return join(process.env.HOME ?? homedir(), ".pi", "agent", "lsp.json");
}

function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "lsp.json");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const STARTER_CONFIG = `{
  "lsp": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]
    },
    "vue": {
      "command": ["vue-language-server", "--stdio"],
      "extensions": [".vue"]
    },
    "svelte": {
      "command": ["svelteserver", "--stdio"],
      "extensions": [".svelte"]
    },
    "python": {
      "command": ["pyright-langserver", "--stdio"],
      "extensions": [".py", ".pyi"]
    },
    "go": {
      "command": ["gopls"],
      "extensions": [".go"]
    },
    "rust": {
      "command": ["rust-analyzer"],
      "extensions": [".rs"]
    },
    "ruby": {
      "command": ["ruby-lsp"],
      "extensions": [".rb"]
    }
  }
}
`;

/**
 * Scaffold a starter global config if neither global nor project config exists.
 * Returns true if a file was created.
 */
export async function scaffoldGlobalConfig(cwd: string): Promise<boolean> {
  const globalPath = globalConfigPath();
  const projectPath = projectConfigPath(cwd);

  if (await fileExists(globalPath)) return false;
  if (await fileExists(projectPath)) return false;

  await mkdir(dirname(globalPath), { recursive: true });
  await writeFile(globalPath, STARTER_CONFIG, "utf8");
  return true;
}

// ── Loading ─────────────────────────────────────────────────────────────────

async function loadJsonFile<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export type CommandAvailability = "global" | "npx" | null;
export type CommandAvailabilityCache = Map<string, CommandAvailability>;

type AvailabilityProbe = (command: string, cwd: string) => CommandAvailability;

function commandAvailableVia(
  command: string,
  cwd: string
): CommandAvailability {
  try {
    execSync(`which ${command}`, { stdio: "pipe", timeout: 5_000 });
    return "global";
  } catch {
    // not global
  }
  try {
    execSync(`npx --yes ${command} --version`, {
      stdio: "pipe",
      cwd,
      timeout: 15_000,
    });
    return "npx";
  } catch {
    return null;
  }
}

// ── Resolving ───────────────────────────────────────────────────────────────

function normalizeServerConfig(
  name: string,
  config: LspServerUserConfig
): ConfiguredServerConfig | null {
  if (config.disabled) return null;
  if (!config.command || config.command.length === 0) return null;
  if (!config.extensions || config.extensions.length === 0) return null;

  return {
    name,
    command: config.command,
    extensions: config.extensions,
    env: config.env ?? {},
    initializationOptions: config.initialization ?? {},
  };
}

function availabilityCacheKey(command: string, cwd: string): string {
  return `${cwd}:${command}`;
}

export function resolveConfiguredServer(
  config: ConfiguredServerConfig,
  cwd: string,
  availabilityCache: CommandAvailabilityCache,
  probe: AvailabilityProbe = commandAvailableVia
): ResolvedServerConfig | null {
  const [rawCommand, ...rawArgs] = config.command;
  const cacheKey = availabilityCacheKey(rawCommand, cwd);
  let via = availabilityCache.get(cacheKey);

  if (via === undefined) {
    via = probe(rawCommand, cwd);
    availabilityCache.set(cacheKey, via);
  }

  if (!via) return null;

  const command = via === "npx" ? "npx" : rawCommand;
  const args = via === "npx" ? ["--yes", rawCommand, ...rawArgs] : rawArgs;

  return {
    name: config.name,
    command,
    args,
    extensions: config.extensions,
    env: config.env,
    initializationOptions: config.initializationOptions,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface LoadedConfig {
  servers: ConfiguredServerConfig[];
  globalDisabled: boolean;
  errors: string[];
}

export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const errors: string[] = [];

  const globalConfig = await loadJsonFile<LspConfigFile>(globalConfigPath());
  const projectConfig = await loadJsonFile<LspConfigFile>(
    projectConfigPath(cwd)
  );

  // Check if globally disabled
  if (globalConfig?.lsp === false || projectConfig?.lsp === false) {
    return { servers: [], globalDisabled: true, errors };
  }

  const globalServers = (
    typeof globalConfig?.lsp === "object" ? globalConfig.lsp : {}
  ) as Record<string, LspServerUserConfig>;
  const projectServers = (
    typeof projectConfig?.lsp === "object" ? projectConfig.lsp : {}
  ) as Record<string, LspServerUserConfig>;

  // Merge: project overrides global
  const allNames = new Set([
    ...Object.keys(globalServers),
    ...Object.keys(projectServers),
  ]);
  const servers: ConfiguredServerConfig[] = [];

  for (const name of allNames) {
    const userConfig: LspServerUserConfig = {
      ...globalServers[name],
      ...projectServers[name],
    };

    // Merge env maps properly
    if (globalServers[name]?.env || projectServers[name]?.env) {
      userConfig.env = {
        ...globalServers[name]?.env,
        ...projectServers[name]?.env,
      };
    }

    const normalized = normalizeServerConfig(name, userConfig);
    if (normalized) {
      servers.push(normalized);
    }
  }

  return { servers, globalDisabled: false, errors };
}

/** Find all servers that handle a given file extension. */
export function serversForExtension<T extends { extensions: string[] }>(
  servers: T[],
  filePath: string
): T[] {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return servers.filter((s) => s.extensions.includes(ext));
}
