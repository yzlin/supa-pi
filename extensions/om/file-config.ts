import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createOmConfigSnapshot } from "./config";
import type { OmConfigSnapshot } from "./types";

export function getOmConfigPath(cwd = process.cwd()): string {
  return join(cwd, ".pi", "om.json");
}

export function loadOmConfig(cwd = process.cwd()): OmConfigSnapshot {
  const configPath = getOmConfigPath(cwd);
  if (!existsSync(configPath)) {
    return createOmConfigSnapshot();
  }

  try {
    return createOmConfigSnapshot(JSON.parse(readFileSync(configPath, "utf8")));
  } catch {
    return createOmConfigSnapshot();
  }
}
