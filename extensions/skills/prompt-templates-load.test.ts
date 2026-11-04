import { expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = join(import.meta.dir, "..", "..");
const promptsDir = join(root, "prompts");

// Regression: an unquoted `: ` in a description made Pi skip prompts/execute.md silently.
it("Pi loads every repo prompt template with no diagnostics", async () => {
  const loader = new DefaultResourceLoader({
    cwd: promptsDir,
    agentDir: join(promptsDir, ".unused-agent-dir"),
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    additionalPromptTemplatePaths: [promptsDir],
  });
  await loader.reload();
  const loaded = loader.getPrompts();
  expect(loaded.diagnostics).toEqual([]);
  const expected = readdirSync(promptsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
  expect(loaded.prompts.map((prompt) => prompt.name).sort()).toEqual(expected);
});
