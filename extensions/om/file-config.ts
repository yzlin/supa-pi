import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createOmConfigSnapshot, mergeOmConfigSnapshot } from "./config";
import type { OmConfigInput, OmConfigSnapshot } from "./types";

export function getGlobalOmConfigPath(homeDir = homedir()): string {
  return join(homeDir, ".pi", "agent", "om.json");
}

export function getOmConfigPath(cwd = process.cwd()): string {
  return join(cwd, ".pi", "om.json");
}

function loadOmConfigFile(configPath: string): OmConfigInput | null {
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as OmConfigInput;
  } catch {
    return null;
  }
}

function loadOmConfigLayers(
  cwd: string,
  homeDir: string
): [OmConfigInput | null, OmConfigInput | null] {
  return [
    loadOmConfigFile(getGlobalOmConfigPath(homeDir)),
    loadOmConfigFile(getOmConfigPath(cwd)),
  ];
}

export function loadOmConfig(
  cwd = process.cwd(),
  homeDir = homedir()
): OmConfigSnapshot {
  const [globalConfig, projectConfig] = loadOmConfigLayers(cwd, homeDir);

  if (!globalConfig && !projectConfig) {
    return createOmConfigSnapshot();
  }

  return mergeOmConfigSnapshot(globalConfig ?? {}, projectConfig ?? {});
}
