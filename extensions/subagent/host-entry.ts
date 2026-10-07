// Apache-2.0 adaptation of mitsuhiko/agent-stuff, d265b8e. Modified for SupaPi: interactive public-SDK child entry for strict resource controls.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";

import { createChildHost } from "./host";
import { atomicJson, readChildConfig } from "./protocol";

const configPath = process.env.SUPA_PI_SUBAGENT_CONFIG;
if (!configPath) {
  throw new Error("Missing child configuration");
}
const directory = path.dirname(configPath);
try {
  const config = await readChildConfig(configPath);
  const host = await createChildHost(config, directory);
  const settings = host.services.settingsManager;
  initTheme(settings.getTheme(), false);
  const mode = new InteractiveMode(host, {
    initialMessage: await readFile(path.join(directory, "task.md"), "utf8"),
    tuiMode: settings.getTuiMode(),
  });
  await mode.run();
} catch (error) {
  await atomicJson(path.join(directory, "startup-error.json"), {
    error: error instanceof Error ? error.message : "Child startup failed",
  });
  process.exit(1);
}
