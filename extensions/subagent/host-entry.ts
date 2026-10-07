import { plugin } from "bun";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Apache-2.0 adaptation of mitsuhiko/agent-stuff, d265b8e. Modified for SupaPi: interactive public-SDK child entry for strict resource controls.
import type * as PiSdk from "@earendil-works/pi-coding-agent";

const configPath = process.env.SUPA_PI_SUBAGENT_CONFIG;
if (!configPath) {
  throw new Error("Missing child configuration");
}
const directory = path.dirname(configPath);
try {
  const parentPackage = process.argv[2];
  if (!parentPackage || !path.isAbsolute(parentPackage)) {
    throw new Error("Missing absolute parent Pi package path");
  }
  const sdk: typeof PiSdk = await import(
    pathToFileURL(path.join(parentPackage, "dist", "index.js")).href
  );
  // Bun's native imports otherwise load the checkout SDK, including the transitive frontmatter parser.
  plugin({
    name: "subagent-parent-pi",
    setup(build) {
      build.onLoad(
        { filter: /[\\/]pi-coding-agent(?:@[^\\/]*)?[\\/]dist[\\/]index\.js$/ },
        () => ({ loader: "object", exports: sdk }),
      );
    },
  });
  const { createChildHost } = await import("./host");
  const { readChildConfig } = await import("./protocol");
  const { initTheme, InteractiveMode } = sdk;
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
  const errorPath = path.join(directory, "startup-error.json");
  await writeFile(
    `${errorPath}.tmp`,
    JSON.stringify({
      error: error instanceof Error ? error.message : "Child startup failed",
    }),
    { mode: 0o600 },
  );
  await rename(`${errorPath}.tmp`, errorPath);
  process.exit(1);
}
