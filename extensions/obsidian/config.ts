import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface ObsidianConfigVault {
  path: string;
  name?: string;
}

export interface ObsidianConfig {
  enabled: boolean;
  vaults: ObsidianConfigVault[];
}

export interface ValidatedVault {
  path: string;
  realPath: string;
  name?: string;
}

export interface LoadedConfig {
  enabled: boolean;
  vaults: ValidatedVault[];
  warnings: string[];
}

function getConfigPath(): string {
  return (
    process.env.PI_OBSIDIAN_CONFIG_PATH ??
    join(homedir(), ".pi", "agent", "obsidian.json")
  );
}

export function expandHome(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

function isAllowedPath(input: string): boolean {
  return isAbsolute(input) || input === "~" || input.startsWith("~/");
}

function readConfigFile(): unknown {
  try {
    return JSON.parse(readFileSync(getConfigPath(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { enabled: false, vaults: [] };
    }
    throw error;
  }
}

export function loadObsidianConfig(): LoadedConfig {
  const raw = readConfigFile() as Partial<ObsidianConfig>;
  const warnings: string[] = [];
  const enabled = raw.enabled === true;
  const vaults: ValidatedVault[] = [];

  for (const vault of Array.isArray(raw.vaults) ? raw.vaults : []) {
    if (
      !vault ||
      typeof vault.path !== "string" ||
      !isAllowedPath(vault.path)
    ) {
      warnings.push("Rejected Obsidian vault with non-absolute path");
      continue;
    }

    const expanded = resolve(expandHome(vault.path));
    try {
      const stat = statSync(expanded);
      const obsidianStat = statSync(join(expanded, ".obsidian"));
      if (!(stat.isDirectory() && obsidianStat.isDirectory())) {
        warnings.push(
          `Rejected Obsidian vault without .obsidian directory: ${expanded}`
        );
        continue;
      }
      vaults.push({
        path: expanded,
        realPath: realpathSync(expanded),
        name: typeof vault.name === "string" ? vault.name : undefined,
      });
    } catch {
      warnings.push(`Rejected missing Obsidian vault: ${expanded}`);
    }
  }

  return { enabled, vaults, warnings };
}
