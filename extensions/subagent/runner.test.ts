// SupaPi additions: offline tests for the Apache-2.0 subagent adaptation; see extensions/subagent/NOTICE and LICENSE.upstream.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { fauxProvider } from "@earendil-works/pi-ai";

import { isRecord } from "./agents";
import { atomicJson, type ChildConfig } from "./protocol";
import { runSubagent, type RunnerAPI, type RunnerContext } from "./runner";

let previousAgentDir: string | undefined;
let previousPackageDir: string | undefined;
beforeEach(async () => {
  previousPackageDir = process.env.PI_PACKAGE_DIR;
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await root();
});
afterEach(() => {
  if (previousPackageDir === undefined) {
    delete process.env.PI_PACKAGE_DIR;
  } else {
    process.env.PI_PACKAGE_DIR = previousPackageDir;
  }
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
const provider = fauxProvider();
const model = provider.getModel();
function context(directory: string): RunnerContext {
  return {
    cwd: directory,
    model,
    isProjectTrusted: () => true,
    scopedModels: [],
    sessionManager: { getSessionId: () => randomUUID() },
    modelRegistry: {
      find: (p, m) =>
        p === model.provider && m === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
    },
  };
}
async function root() {
  return mkdtemp(path.join(tmpdir(), "supa-subagent-runner-"));
}
test("runner rejects empty tasks, unknown model, absent auth and out-of-scope model before launch", async () => {
  const ctx = context(await root());
  let calls = 0;
  const pi: RunnerAPI = {
    getThinkingLevel: () => "off",
    exec: async () => {
      calls++;
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };
  await rejects(runSubagent(pi, ctx, { task: "" }), /empty/);
  await rejects(
    runSubagent(pi, ctx, { task: "task", model: "wrong" }),
    /model/,
  );
  await rejects(
    runSubagent(
      pi,
      {
        ...ctx,
        modelRegistry: { ...ctx.modelRegistry, hasConfiguredAuth: () => false },
      },
      { task: "task" },
    ),
    /auth/,
  );
  await rejects(
    runSubagent(
      pi,
      {
        ...ctx,
        scopedModels: [
          { model: { ...model, id: "other" }, thinkingLevel: "off" },
        ],
      },
      { task: "task" },
    ),
    /scope/,
  );
  expect(calls).toBe(0);
});
test("ordinary child launch uses the parent Pi package instead of the repository dependency", async () => {
  const dir = await root();
  const parentPackage = path.join(dir, "parent Pi 1.0.4");
  process.env.PI_PACKAGE_DIR = parentPackage;
  let launchScript = "";
  const pi: RunnerAPI = {
    getThinkingLevel: () => "off",
    exec: async (_cmd, args) => {
      if (args.includes("send-keys") && args.includes("-l")) {
        const launchPath = args.at(-1)?.match(/\/bin\/sh '([^']+)'/)?.[1];
        if (!launchPath) {
          throw new Error("Missing launcher");
        }
        launchScript = await readFile(launchPath, "utf8");
        throw new Error("Launch inspected");
      }
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };
  await rejects(
    runSubagent(pi, context(dir), { task: "task" }),
    /Launch inspected/,
  );
  expect(launchScript).toContain(
    `'${path.join(parentPackage, "dist", "bundle", "cli.js")}'`,
  );
  expect(launchScript).toContain(`'${process.execPath}'`);
});

test("strict-skill child launch passes the parent Pi package to its SDK host", async () => {
  const dir = await root();
  const agentDir = await root();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const parentPackage = path.join(dir, "parent Pi runtime");
  process.env.PI_PACKAGE_DIR = parentPackage;
  await mkdir(path.join(agentDir, "agents"));
  await writeFile(
    path.join(agentDir, "agents", "strict.md"),
    "---\nname: strict\nskills: false\n---\nStrict role",
  );
  let launchScript = "";
  const pi: RunnerAPI = {
    getThinkingLevel: () => "off",
    exec: async (_cmd, args) => {
      if (args.includes("send-keys") && args.includes("-l")) {
        const launchPath = args.at(-1)?.match(/\/bin\/sh '([^']+)'/)?.[1];
        if (!launchPath) {
          throw new Error("Missing launcher");
        }
        launchScript = await readFile(launchPath, "utf8");
        throw new Error("Launch inspected");
      }
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };
  await rejects(
    runSubagent(pi, context(dir), { task: "task", agent: "strict" }),
    /Launch inspected/,
  );
  expect(launchScript).toContain("host-entry.ts'");
  expect(launchScript).toContain(`'${parentPackage}'`);
});

async function inspectLaunch(
  dir: string,
  agent?: string,
): Promise<{ launchScript: string; config: ChildConfig }> {
  let launchScript = "";
  let configPath = "";
  const pi: RunnerAPI = {
    getThinkingLevel: () => "off",
    exec: async (_cmd, args) => {
      if (args.includes("send-keys") && args.includes("-l")) {
        const launchPath = args.at(-1)?.match(/\/bin\/sh '([^']+)'/)?.[1];
        if (!launchPath) {
          throw new Error("Missing launcher");
        }
        launchScript = await readFile(launchPath, "utf8");
        configPath = path.join(path.dirname(launchPath), "config.json");
        throw new Error("Launch inspected");
      }
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };
  await rejects(
    runSubagent(pi, context(dir), { task: "task", agent }),
    /Launch inspected/,
  );
  return {
    launchScript,
    config: JSON.parse(await readFile(configPath, "utf8")) as ChildConfig,
  };
}

test("extension-isolated roles keep only the configured extensions of their selected provider", async () => {
  const dir = await root();
  const agentDir = await root();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(path.join(agentDir, "agents"));
  await writeFile(
    path.join(agentDir, "agents", "isolated.md"),
    "---\nname: isolated\nextensions: false\n---\nIsolated role",
  );
  await writeFile(
    path.join(agentDir, "agents", "open.md"),
    "---\nname: open\n---\nOpen role",
  );
  await writeFile(
    path.join(agentDir, "subagent.json"),
    JSON.stringify({
      providerExtensions: {
        [model.provider]: ["../bridge", "/abs/bridge.ts"],
        other: ["/abs/other.ts"],
      },
    }),
  );
  const bridge = path.resolve(agentDir, "../bridge");
  const isolated = await inspectLaunch(dir, "isolated");
  expect(isolated.config.providerExtensions).toEqual([
    bridge,
    "/abs/bridge.ts",
  ]);
  expect(isolated.launchScript).toContain(
    `'--no-extensions' '--extension' '${bridge}' '--extension' '/abs/bridge.ts'`,
  );
  expect(isolated.launchScript).not.toContain("/abs/other.ts");
  const open = await inspectLaunch(dir, "open");
  expect(open.config.providerExtensions).toBeUndefined();
  expect(open.launchScript).not.toContain("bridge");
});

test("malformed provider extension settings fail before launch", async () => {
  const dir = await root();
  const agentDir = await root();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(path.join(agentDir, "agents"));
  await writeFile(
    path.join(agentDir, "agents", "isolated.md"),
    "---\nname: isolated\nextensions: false\n---\nIsolated role",
  );
  await writeFile(
    path.join(agentDir, "subagent.json"),
    JSON.stringify({ providerExtensions: { [model.provider]: "bridge" } }),
  );
  let calls = 0;
  const pi: RunnerAPI = {
    getThinkingLevel: () => "off",
    exec: async () => {
      calls++;
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };
  await rejects(
    runSubagent(pi, context(dir), { task: "task", agent: "isolated" }),
    /subagent\.json/,
  );
  expect(calls).toBe(0);
});

test("startup failure closes owned tmux and retains owner-only failure evidence", async () => {
  const dir = await root();
  const calls: string[][] = [];
  const pi: RunnerAPI = {
    getThinkingLevel: () => "off",
    exec: async (_cmd, args) => {
      calls.push(args);
      return {
        code: args.includes("set-window-option") ? 1 : 0,
        stdout: "",
        stderr: "startup fixture",
        killed: false,
      };
    },
  };
  await rejects(
    runSubagent(pi, context(dir), { task: "task" }),
    /startup fixture/,
  );
  expect(calls.some((args) => args.includes("kill-session"))).toBe(true);
});
test("completed report bound to run and schema; full evidence private; finished tmux cleaned", async () => {
  const dir = await root();
  const calls: string[][] = [];
  let config: ChildConfig | undefined;
  let evidence = "";
  const pi: RunnerAPI = {
    getThinkingLevel: () => "off",
    exec: async (_cmd, args) => {
      calls.push(args);
      if (args.includes("send-keys") && args.includes("-l")) {
        const command = args.at(-1) ?? "";
        const launchPath = command.match(/\/bin\/sh '([^']+)'/)?.[1];
        if (!launchPath) {
          throw new Error("Missing launcher");
        }
        const launchScript = await readFile(launchPath, "utf8");
        const matched = launchScript.match(/SUPA_PI_SUBAGENT_CONFIG='([^']+)'/);
        if (!matched) {
          throw new Error("Missing bootstrap config");
        }
        evidence = path.dirname(matched[1]);
        config = JSON.parse(await readFile(matched[1], "utf8"));
        if (!config) {
          throw new Error("Missing config");
        }
        const sessionFile = path.join(evidence, "session", "child.jsonl");
        await atomicJson(sessionFile, {
          type: "session",
          id: config.runId,
          cwd: config.cwd,
        });
        await atomicJson(path.join(evidence, "result.json"), {
          sessionFile,
          ...config,
          agent: config.agent?.name,
          schema: undefined,
          trusted: undefined,
          cwd: undefined,
          dialogSocket: undefined,
          status: "completed",
          output: "complete output",
          structuredOutput: { ok: true },
          finishedAt: Date.now(),
        });
      }
      return { code: 0, stdout: "live pane", stderr: "", killed: false };
    },
  };
  const result = await runSubagent(pi, context(dir), {
    task: "task",
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
  });
  expect(result.output).toBe("complete output");
  expect(result.structuredOutput).toEqual({ ok: true });
  if (!config) {
    throw new Error("Missing config");
  }
  expect(result.runId).toBe(config.runId);
  expect((await stat(result.resultPath)).mode % 512).toBe(0o600);
  expect((await stat(evidence)).mode % 512).toBe(0o700);
  expect(calls.some((args) => args.includes("kill-session"))).toBe(true);
});

test("tmux loss, dead pane and malformed report fail promptly and always close owned session", async () => {
  for (const mode of ["lost", "dead", "malformed"] as const) {
    const dir = await root();
    let cleaned = false;
    const pi: RunnerAPI = {
      getThinkingLevel: () => "off",
      exec: async (_cmd, args) => {
        if (args.includes("kill-session")) {
          cleaned = true;
        }
        if (
          mode === "malformed" &&
          args.includes("send-keys") &&
          args.includes("-l")
        ) {
          const launcher = args.at(-1)?.match(/\/bin\/sh '([^']+)'/)?.[1];
          if (!launcher) {
            throw new Error("Missing launch");
          }
          const script = await readFile(launcher, "utf8");
          const configFile = script.match(
            /SUPA_PI_SUBAGENT_CONFIG='([^']+)'/,
          )?.[1];
          if (!configFile) {
            throw new Error("Missing config");
          }
          await atomicJson(path.join(path.dirname(configFile), "result.json"), {
            nonsense: true,
          });
        }
        return {
          code: mode === "lost" && args.includes("capture-pane") ? 1 : 0,
          stdout: args.includes("display-message") ? "1" : "",
          stderr: "tmux lost fixture",
          killed: false,
        };
      },
    };
    await rejects(
      runSubagent(pi, context(dir), { task: "task" }),
      {
        lost: /tmux lost fixture/,
        dead: /without reporting/,
        malformed: /Malformed child result/,
      }[mode],
    );
    expect(cleaned).toBe(true);
  }
});

test("abort from live update stops before querying the killed server and cleans socket metadata target", async () => {
  const dir = await root();
  const controller = new AbortController();
  const calls: string[][] = [];
  let socket = "";
  let command = "";
  let runDirectory = "";
  const pi: RunnerAPI = {
    getThinkingLevel: () => "off",
    exec: async (_cmd, args) => {
      calls.push(args);
      socket = args[args.indexOf("-S") + 1];
      if (args.includes("send-keys") && args.includes("-l")) {
        const launcher = args.at(-1)?.match(/\/bin\/sh '([^']+)'/)?.[1];
        if (!launcher) {
          throw new Error("Missing launcher");
        }
        runDirectory = path.dirname(launcher);
      }
      return {
        code: args.includes("display-message") ? 1 : 0,
        stdout: "live",
        stderr: "server exited unexpectedly",
        killed: false,
      };
    },
  };
  await rejects(
    runSubagent(
      pi,
      context(dir),
      { task: "task" },
      {
        signal: controller.signal,
        onUpdate: (update) => {
          if (update.status !== "running") {
            return;
          }
          command = update.attachCommand ?? "";
          controller.abort();
        },
      },
    ),
    /aborted/,
  );
  expect(command).toMatch(/^pi --attach-subagent [0-9a-f-]+$/);
  expect(calls.some((args) => args.includes("display-message"))).toBe(false);
  expect(calls.some((args) => args.includes("kill-server"))).toBe(true);
  await rejects(stat(path.dirname(socket)), /ENOENT/);
  const metadata = JSON.parse(
    await readFile(path.join(runDirectory, "attach.json"), "utf8"),
  );
  expect(metadata.socket).toBe(socket);
  expect((await stat(path.join(runDirectory, "attach.json"))).mode % 512).toBe(
    0o600,
  );
});

test("abort waits for the child pane process to exit and force-kills it after the grace period", async () => {
  const { spawn } = await import("node:child_process");
  // Stands in for a child Pi that survives tmux teardown (fake tmux sends no signal).
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.once("exit", (_code, signal) => resolve(signal)),
  );
  const controller = new AbortController();
  const pi: RunnerAPI = {
    getThinkingLevel: () => "off",
    exec: async (_cmd, args) => ({
      code: args.includes("display-message") ? 1 : 0,
      stdout: args.includes("list-panes") ? `${child.pid}\n` : "live",
      stderr: "",
      killed: false,
    }),
  };
  try {
    await rejects(
      runSubagent(
        pi,
        context(await root()),
        { task: "task" },
        {
          signal: controller.signal,
          onUpdate: (update) => {
            if (update.status === "running") {
              controller.abort();
            }
          },
        },
      ),
      /aborted/,
    );
    // The runner settles only after the child process is gone.
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(await exited).toBe("SIGKILL");
  } finally {
    child.kill("SIGKILL");
  }
}, 10_000);

test("parent refuses unsafe result evidence permissions", async () => {
  const { chmod } = await import("node:fs/promises");
  const dir = await root();
  const pi: RunnerAPI = {
    getThinkingLevel: () => "off",
    exec: async (_cmd, args) => {
      if (args.includes("send-keys") && args.includes("-l")) {
        const launcher = args.at(-1)?.match(/\/bin\/sh '([^']+)'/)?.[1];
        if (!launcher) {
          throw new Error("Missing launch");
        }
        const configPath = (await readFile(launcher, "utf8")).match(
          /SUPA_PI_SUBAGENT_CONFIG='([^']+)'/,
        )?.[1];
        if (!configPath) {
          throw new Error("Missing config");
        }
        const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));
        if (!isRecord(raw)) {
          throw new Error("Missing config");
        }
        const result = path.join(path.dirname(configPath), "result.json");
        await atomicJson(result, {
          version: 1,
          runId: raw.runId,
          parentSessionId: raw.parentSessionId,
          provider: raw.provider,
          model: raw.model,
          thinking: raw.thinking,
          status: "completed",
          output: "text",
          finishedAt: Date.now(),
        });
        await chmod(result, 0o644);
      }
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };
  await rejects(runSubagent(pi, context(dir), { task: "task" }), /owner-only/);
});

/** Launch fixture: sends one child dialog over the configured relay, then reports completion. */
async function relayRun(ctx: RunnerContext, signal?: AbortSignal) {
  const seen: {
    socket?: string;
    socketMode?: number;
    answer?: unknown;
    config?: ChildConfig;
  } = {};
  const pi: RunnerAPI = {
    getThinkingLevel: () => "off",
    exec: async (_cmd, args) => {
      if (args.includes("send-keys") && args.includes("-l")) {
        const launcher = args.at(-1)?.match(/\/bin\/sh '([^']+)'/)?.[1];
        if (!launcher) {
          throw new Error("Missing launch");
        }
        const configPath = (await readFile(launcher, "utf8")).match(
          /SUPA_PI_SUBAGENT_CONFIG='([^']+)'/,
        )?.[1];
        if (!configPath) {
          throw new Error("Missing config");
        }
        const config: ChildConfig = JSON.parse(
          await readFile(configPath, "utf8"),
        );
        seen.config = config;
        seen.socket = args[args.indexOf("-S") + 1];
        if (!config.dialogSocket) {
          throw new Error("Missing dialog socket");
        }
        seen.socketMode = (await stat(config.dialogSocket)).mode % 512;
        const child = createConnection(config.dialogSocket);
        child.setEncoding("utf8");
        child.write(
          `${JSON.stringify({ type: "dialog", id: "q", kind: "confirm", title: "Go?", message: "now" })}\n`,
        );
        seen.answer = JSON.parse(
          await new Promise<string>((resolve) =>
            child.once("data", (line: string) => resolve(line)),
          ),
        );
        child.destroy();
        const sessionFile = path.join(
          path.dirname(configPath),
          "session",
          "child.jsonl",
        );
        await atomicJson(sessionFile, {
          type: "session",
          id: config.runId,
          cwd: config.cwd,
        });
        await atomicJson(path.join(path.dirname(configPath), "result.json"), {
          version: 1,
          runId: config.runId,
          parentSessionId: config.parentSessionId,
          provider: config.provider,
          model: config.model,
          thinking: config.thinking,
          status: "completed",
          output: "done",
          sessionFile,
          finishedAt: Date.now(),
        });
      }
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };
  const result = await runSubagent(pi, ctx, { task: "task" }, { signal });
  return { result, seen };
}

test("runner relays child dialogs to the labeled parent UI over an owner-only socket removed at completion", async () => {
  const dir = await root();
  const titles: string[] = [];
  const { result, seen } = await relayRun({
    ...context(dir),
    hasUI: true,
    ui: {
      confirm: async (title) => {
        titles.push(title);
        return true;
      },
      select: async () => undefined,
      input: async () => undefined,
    },
  });
  expect(result.output).toBe("done");
  if (!seen.socket || !seen.config) {
    throw new Error("Missing launch");
  }
  expect(seen.config.dialogSocket).toBe(
    path.join(path.dirname(seen.socket), "d"),
  );
  expect(seen.socketMode).toBe(0o600);
  expect(titles).toEqual([`Subagent generic ${result.runId}: Go?`]);
  expect(seen.answer).toEqual({ type: "answer", id: "q", value: true });
  await rejects(stat(path.dirname(seen.socket)), /ENOENT/);
});

test("runner without parent UI denies relayed child dialogs", async () => {
  for (const ui of [{ hasUI: false }, {}]) {
    const dir = await root();
    const { seen } = await relayRun({ ...context(dir), ...ui });
    expect(seen.answer).toEqual({
      type: "answer",
      id: "q",
      value: false,
      unavailable: true,
    });
  }
});
