// SupaPi additions: offline tests for the Apache-2.0 subagent adaptation; see extensions/subagent/NOTICE and LICENSE.upstream.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
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
