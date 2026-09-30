import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { registerModelProfiles } from "./index";

let root: string;
let agentDir: string;
let repo: string;
let configPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "profiles-runtime-"));
  agentDir = join(root, "agent");
  repo = join(root, "repo", "agents");
  configPath = join(agentDir, "model-profiles.json");
  mkdirSync(repo, { recursive: true });
  mkdirSync(agentDir);
  writeFileSync(
    join(repo, "file.md"),
    "---\nname: worker\nmodel: p/base\nthinking: low\n---\nBody\n",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function config(value: unknown) {
  writeFileSync(configPath, JSON.stringify(value));
}
function readConfig() {
  return JSON.parse(readFileSync(configPath, "utf8"));
}
function harness(
  auth = true,
  setModelResult = true,
  injectedAgentDir = agentDir,
  onPersist?: () => void,
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let command: Parameters<ExtensionAPI["registerCommand"]>[1];
  const changes: string[] = [];
  const notifications: string[] = [];
  const statuses: (string | undefined)[] = [];
  const selections: string[][] = [];
  const model = { provider: "p", id: "new" };
  let thinking = "high";
  const ctx = {
    cwd: root,
    hasUI: true,
    model,
    scopedModels: [],
    modelRegistry: {
      find(provider: string, id: string) {
        return provider === "p" && ["new", "base"].includes(id)
          ? { provider, id }
          : undefined;
      },
      hasConfiguredAuth() {
        return auth;
      },
    },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus(_key: string, value: string | undefined) {
        statuses.push(value);
      },
      select(_title: string, choices: string[]) {
        selections.push(choices);
        return Promise.resolve(
          choices.find((value) => value.startsWith("work")),
        );
      },
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand(
      _name: string,
      options: Parameters<ExtensionAPI["registerCommand"]>[1],
    ) {
      command = options;
    },
    setModel(value: typeof model) {
      changes.push(`model:${value.provider}/${value.id}`);
      // Mirrors Pi: switching models resets thinking to model/global defaults.
      thinking = "low";
      return Promise.resolve(setModelResult);
    },
    setThinkingLevel(level: string) {
      changes.push(`thinking:${level}`);
      thinking = level;
    },
    getThinkingLevel() {
      return thinking;
    },
  } as unknown as ExtensionAPI;
  registerModelProfiles(pi, {
    agentDir: injectedAgentDir,
    repoAgentsDir: repo,
    persistMain(_cwd, _dir, values) {
      changes.push(`persist:${JSON.stringify(values)}`);
      onPersist?.();
      return Promise.resolve();
    },
  });
  return {
    ctx,
    handlers,
    changes,
    notifications,
    statuses,
    selections,
    command: command!,
  };
}
const work = {
  main: { model: "p/new", thinking: "max" },
  agents: { worker: { model: "p/new", thinking: "high" } },
};

test("switch validates then sets main/thinking, renders agents, persists defaults and active; default leaves main unchanged", async () => {
  config({ $schema: "editor", note: "keep", profiles: { work } });
  const h = harness();
  await h.command.handler("work", h.ctx);
  expect(h.changes).toEqual([
    "model:p/new",
    "thinking:max",
    'persist:{"model":"p/new","thinking":"max"}',
  ]);
  expect(readConfig()).toMatchObject({
    $schema: "editor",
    note: "keep",
    active: "work",
  });
  expect(readFileSync(join(agentDir, "agents", "file.md"), "utf8")).toContain(
    "model: p/new",
  );
  expect(h.statuses.at(-1)).toBe("profile: work");
  await h.command.handler("default", h.ctx);
  expect(h.changes).toHaveLength(3);
  expect(h.statuses.at(-1)).toBeUndefined();
  expect(readConfig().active).toBe("default");
});

test("all validation failures in one notification, no setModel and no writes", async () => {
  config({
    profiles: {
      bad: {
        main: { model: "missing/main" },
        agents: {
          "*": { model: "p/new" },
          unknown: { model: "missing/agent" },
        },
      },
    },
  });
  const before = readFileSync(configPath, "utf8");
  const h = harness(false);
  h.ctx.scopedModels = [
    {
      model: { provider: "p", id: "base" },
    } as ExtensionCommandContext["scopedModels"][number],
  ];
  await h.command.handler("bad", h.ctx);
  expect(h.notifications).toHaveLength(1);
  for (const text of [
    configPath,
    "missing/main",
    "unknown",
    "missing/agent",
    "auth",
    "scope",
  ]) {
    expect(h.notifications[0]).toContain(text);
  }
  expect(h.changes).toEqual([]);
  expect(readFileSync(configPath, "utf8")).toBe(before);
  expect(existsSync(join(agentDir, "agents"))).toBe(false);
});

test("invalid thinking and model registry failures are collected together", async () => {
  config({
    profiles: {
      bad: {
        main: { thinking: "nope", model: "missing/main" },
        agents: { unknown: { thinking: "wrong" } },
      },
    },
  });
  const h = harness();
  await h.command.handler("bad", h.ctx);
  expect(h.notifications).toHaveLength(1);
  for (const field of [
    "main.thinking",
    "unknown.thinking",
    "missing/main",
    "unknown agent",
  ]) {
    expect(h.notifications[0]).toContain(field);
  }
  expect(h.changes).toEqual([]);
  expect(existsSync(join(agentDir, "agents"))).toBe(false);
});

test("setModel false stops thinking, files, settings and active writes", async () => {
  config({ profiles: { work } });
  const before = readFileSync(configPath, "utf8");
  const h = harness(true, false);
  await h.command.handler("work", h.ctx);
  expect(h.changes).toEqual(["model:p/new"]);
  expect(h.notifications.join()).toContain("auth");
  expect(readFileSync(configPath, "utf8")).toBe(before);
  expect(existsSync(join(agentDir, "agents"))).toBe(false);
});

test("save snapshots main and keeps agents, schema and active unchanged", async () => {
  config({ $schema: "schema", profiles: { work }, active: "default" });
  const h = harness();
  await h.command.handler("save work", h.ctx);
  expect(readConfig()).toEqual({
    $schema: "schema",
    profiles: { work: { ...work, main: { model: "p/new", thinking: "high" } } },
    active: "default",
  });
  expect(h.changes).toEqual([]);
  await h.command.handler("save default", h.ctx);
  expect(readConfig().profiles.default).toBeUndefined();
  await h.command.handler("save fresh", h.ctx);
  expect(readConfig().profiles.fresh.main).toEqual({
    model: "p/new",
    thinking: "high",
  });
  expect(readConfig().active).toBe("default");
});

test("model-only main profile preserves current thinking across setModel reset", async () => {
  config({ profiles: { solo: { main: { model: "p/new" } } } });
  const h = harness();
  await h.command.handler("solo", h.ctx);
  expect(h.changes).toEqual([
    "model:p/new",
    "thinking:high",
    'persist:{"model":"p/new"}',
  ]);
});

test("switch keeps profiles saved by another session during awaited persistence", async () => {
  config({ profiles: { work } });
  const h = harness(true, true, agentDir, () => {
    const other = readConfig();
    other.profiles.other = { main: { thinking: "low" } };
    config(other);
  });
  await h.command.handler("work", h.ctx);
  expect(readConfig()).toMatchObject({
    active: "work",
    profiles: { work, other: { main: { thinking: "low" } } },
  });
});

test("default restores after a referenced repository agent is deleted; applying the stale profile still fails", async () => {
  config({ profiles: { work } });
  const h = harness();
  await h.command.handler("work", h.ctx);
  expect(existsSync(join(agentDir, "agents", "file.md"))).toBe(true);
  rmSync(join(repo, "file.md"));
  await h.command.handler("default", h.ctx);
  expect(readConfig().active).toBe("default");
  expect(existsSync(join(agentDir, "agents", "file.md"))).toBe(false);
  await h.command.handler("work", h.ctx);
  expect(h.notifications.at(-1)).toContain("unknown agent name");
  expect(readConfig().active).toBe("default");
});

test("spawn refresh failure blocks only while generated overrides exist", async () => {
  writeFileSync(configPath, "invalid json");
  const h = harness();
  expect(
    await h.handlers.get("tool_call")!({ toolName: "Agent" }, h.ctx),
  ).toBeUndefined();
  config({ active: "work", profiles: { work } });
  await h.handlers.get("session_start")!({}, h.ctx);
  writeFileSync(configPath, "invalid json");
  expect(
    await h.handlers.get("tool_call")!({ toolName: "Agent" }, h.ctx),
  ).toMatchObject({ block: true, reason: expect.stringContaining(configPath) });
});

test("session start renders but never switches main; spawn hooks refresh idempotently", async () => {
  config({ active: "work", profiles: { work } });
  const h = harness();
  await h.handlers.get("session_start")!({}, h.ctx);
  expect(h.changes).toEqual([]);
  expect(h.statuses.at(-1)).toBe("profile: work");
  const before = readFileSync(join(agentDir, "agents", "file.md"), "utf8");
  await h.handlers.get("tool_call")!({ toolName: "Agent" }, h.ctx);
  expect(readFileSync(join(agentDir, "agents", "file.md"), "utf8")).toBe(
    before,
  );
  writeFileSync(configPath, "invalid json");
  expect(
    await h.handlers.get("tool_call")!({ toolName: "SubagentWorkflow" }, h.ctx),
  ).toMatchObject({ block: true });
  expect(h.notifications.at(-1)).toContain(configPath);
  const count = h.notifications.length;
  await h.handlers.get("tool_call")!({ toolName: "bash" }, h.ctx);
  expect(h.notifications).toHaveLength(count);
});

test("bare selector marks active; headless bare/status prints; completions expose names", async () => {
  config({ active: "work", profiles: { work } });
  const h = harness();
  await h.command.handler("", h.ctx);
  expect(h.selections[0]).toContain("default");
  expect(
    h.selections[0].some(
      (value) => value.startsWith("work") && value !== "work",
    ),
  ).toBe(true);
  expect(h.command.getArgumentCompletions?.("w")).toEqual([
    { value: "work", label: "work" },
  ]);
  h.ctx.hasUI = false;
  await h.command.handler("", h.ctx);
  await h.command.handler("status", h.ctx);
  expect(h.notifications.at(-1)).toBe("profile: work");
});

test("missing config is a no-op; malformed and invalid configs fail closed", async () => {
  const h = harness();
  await h.handlers.get("session_start")!({}, h.ctx);
  expect(readdirSync(agentDir)).toEqual([]);
  for (const invalid of [
    "{",
    JSON.stringify({ profiles: { default: {} } }),
    JSON.stringify({ active: "missing", profiles: {} }),
    JSON.stringify({ profiles: { work: { agents: [] } } }),
  ]) {
    writeFileSync(configPath, invalid);
    await h.handlers.get("session_start")!({}, h.ctx);
    expect(h.notifications.at(-1)).toContain(configPath);
    expect(existsSync(join(agentDir, "agents"))).toBe(false);
  }
  expect(h.changes).toEqual([]);
});

test("save never writes config inside repository agents, including through an ancestor symlink", async () => {
  const h = harness(true, true, repo);
  await h.command.handler("save work", h.ctx);
  expect(existsSync(join(repo, "model-profiles.json"))).toBe(false);
  expect(h.notifications.join()).toContain("repository agents");
  const alias = join(root, "repo-alias");
  symlinkSync(repo, alias);
  const aliased = harness(true, true, alias);
  await aliased.command.handler("save work", aliased.ctx);
  expect(existsSync(join(repo, "model-profiles.json"))).toBe(false);
});
