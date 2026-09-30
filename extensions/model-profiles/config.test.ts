import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  parseConfig,
  THINKING_LEVELS,
  writeConfig,
} from "./config";
import { persistMain } from "./index";

let root: string;
let path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "profiles-config-"));
  path = join(root, "model-profiles.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("missing file; strict shape and field errors including all allowed thinking levels", () => {
  expect(loadConfig(path)).toBeUndefined();
  for (const thinking of THINKING_LEVELS) {
    expect(
      parseConfig({ profiles: { work: { main: { thinking } } } }, path).profiles
        .work.main?.thinking,
    ).toBe(thinking);
  }
  for (const raw of [
    null,
    [],
    {},
    { profiles: [] },
    { profiles: { default: {} } },
    { profiles: { work: null } },
    { profiles: { work: { main: [] } } },
    { profiles: { work: { main: { model: "bare", thinking: "invalid" } } } },
    { profiles: { work: { agents: { worker: null } } } },
    { profiles: { work: { mains: {} } } },
    { profiles: { work: { main: { effort: "high" } } } },
    { profiles: {}, active: 1 },
    { profiles: {}, $schema: 1 },
  ]) {
    expect(() => parseConfig(raw, path)).toThrow(path);
  }
});

test("atomic config writes preserve unknown keys and leave no temporary artifacts", () => {
  const config = {
    $schema: "schema",
    future: { keep: true },
    profiles: { work: { agents: { "*": { model: "p/id" } } } },
  };
  writeConfig(path, config);
  expect(loadConfig(path)).toEqual(config);
  writeConfig(path, { ...config, active: "work" });
  expect(loadConfig(path)?.active).toBe("work");
  expect(readdirSync(root)).toEqual(["model-profiles.json"]);
  writeFileSync(path, "{");
  expect(() => loadConfig(path)).toThrow(path);
});

test("real SettingsManager persistence writes global defaults in an injected temp agent dir", async () => {
  const agentDir = join(root, "agent");
  await persistMain(root, agentDir, {
    model: "p/id/with-slash",
    thinking: "max",
  });
  expect(
    JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")),
  ).toMatchObject({
    defaultProvider: "p",
    defaultModel: "id/with-slash",
    defaultThinkingLevel: "max",
  });
});
