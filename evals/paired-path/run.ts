// Paired old-vs-new path eval. See README.md. Usage:
//   bun evals/paired-path/run.ts --dry-run
//   bun evals/paired-path/run.ts --old <worktree> --new <worktree> [--case id]... [--repetitions n] [--model provider/id] [--thinking level]
// Live runs spend real model calls; the CLI refuses them unless --live is given.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  type Arm,
  CASES,
  type DialogRule,
  type PairedCase,
  PROBES,
} from "./cases";

const REAL_HOME = homedir();
const REAL_AGENT = join(REAL_HOME, ".pi", "agent");
const CLAUDE_CODE_PACKAGE = join(REAL_HOME, "dev", "yzlin", "pi-claude-code");
const RUN_TIMEOUT_MS = 25 * 60 * 1000;

export interface Options {
  old?: string;
  new?: string;
  caseIds: string[];
  repetitions: number;
  model: string;
  thinking: string;
  out: string;
  live: boolean;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    caseIds: [],
    repetitions: 1,
    model: "claude-code/claude-opus-5-5",
    thinking: "medium",
    out: join(
      "/tmp",
      "supa-pi-paired",
      "runs",
      new Date().toISOString().replace(/[:.]/gu, "-"),
    ),
    live: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) {
        throw new Error(`${flag} needs a value`);
      }
      return next;
    };
    switch (flag) {
      case "--old":
        options.old = resolve(value());
        break;
      case "--new":
        options.new = resolve(value());
        break;
      case "--case":
        options.caseIds.push(value());
        break;
      case "--repetitions":
        options.repetitions = Number.parseInt(value(), 10);
        break;
      case "--model":
        options.model = value();
        break;
      case "--thinking":
        options.thinking = value();
        break;
      case "--out":
        options.out = resolve(value());
        break;
      case "--live":
        options.live = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error("--repetitions must be a positive integer");
  }
  const unknown = options.caseIds.filter(
    (id) => !CASES.some((c) => c.id === id),
  );
  if (unknown.length) {
    throw new Error(`unknown case: ${unknown.join(", ")}`);
  }
  return options;
}

function sh(
  cwd: string,
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
  });
  return {
    code: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** Seed a git repo: committed files, then the dirty overlay. */
export function seedWorkspace(dir: string, testCase: PairedCase) {
  mkdirSync(dir, { recursive: true });
  write(dir, testCase.fixture.files);
  writeFileSync(join(dir, ".gitignore"), ".pi/\n");
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", [
    "-c",
    "user.name=eval",
    "-c",
    "user.email=eval@example.invalid",
    "commit",
    "-qm",
    "seed",
  ]);
  if (testCase.fixture.dirty) {
    write(dir, testCase.fixture.dirty);
  }
}

/**
 * An isolated HOME whose ~/.pi/agent mirrors the live wiring but points every
 * repo-owned resource at one worktree. Credentials and the claude-code provider
 * are shared read-only; the claude binary keeps the real HOME for its login.
 */
export function buildHome(home: string, worktree: string, base: string) {
  const agent = join(home, ".pi", "agent");
  mkdirSync(join(agent, "extensions"), { recursive: true });
  for (const name of ["agents", "prompts", "rules", "themes"]) {
    symlinkSync(join(worktree, name), join(agent, name));
  }
  symlinkSync(join(worktree, "AGENTS.global.md"), join(agent, "AGENTS.md"));
  symlinkSync(worktree, join(agent, "extensions", "supa-pi"));
  // subagent.json loads the claude-code provider in children from git/; review.json
  // is the old /review panel config. Both mirror the live setup read-only.
  for (const name of [
    "auth.json",
    "models.json",
    "subagent.json",
    "review.json",
    "git",
  ]) {
    if (existsSync(join(REAL_AGENT, name))) {
      symlinkSync(join(REAL_AGENT, name), join(agent, name));
    }
  }
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify(
      {
        packages: [CLAUDE_CODE_PACKAGE],
        defaultProvider: "claude-code",
        defaultModel: "claude-opus-5-5",
        defaultThinkingLevel: "medium",
        enableSkillCommands: true,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(agent, "caveman.json"),
    JSON.stringify({ enabled: false }),
  );
  writeFileSync(join(agent, "trust.json"), JSON.stringify({ [base]: true }));
  const wrapper = join(home, "claude");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nHOME=${JSON.stringify(REAL_HOME)} exec claude "$@"\n`,
    { mode: 0o755 },
  );
  return { agent, wrapper };
}

function answer(
  rule: DialogRule | undefined,
  request: Record<string, unknown>,
) {
  const method = request.method;
  if (method === "confirm") {
    return { confirmed: rule ? rule.reply !== false : true };
  }
  if (method === "select") {
    const options = (request.options as string[] | undefined) ?? [];
    const wanted =
      typeof rule?.reply === "string" ? rule.reply.toLowerCase() : "";
    const pick =
      options.find(
        (option) => wanted && option.toLowerCase().includes(wanted),
      ) ??
      options.find((option) =>
        /^(yes|accept|approve|run|use|allow|continue)/iu.test(option),
      ) ??
      options[0];
    return pick === undefined ? { cancelled: true } : { value: pick };
  }
  if (method === "input" || method === "editor") {
    return typeof rule?.reply === "string"
      ? { value: rule.reply }
      : { cancelled: true };
  }
  return null;
}

interface RunRecord {
  caseId: string;
  arm: Arm;
  repetition: number;
  workspace: string;
  home: string;
  stdout: string;
  dialogs: { method: unknown; title: unknown; reply: unknown }[];
  exit: string;
  ms: number;
}

/** Drive one RPC session: send the prompt, answer dialogs, stop at agent_settled. */
export function runOne(
  testCase: PairedCase,
  arm: Arm,
  worktree: string,
  dir: string,
  options: Options,
  repetition: number,
): Promise<RunRecord> {
  const workspace = join(dir, "ws");
  const home = join(dir, "home");
  seedWorkspace(workspace, testCase);
  const { wrapper } = buildHome(home, worktree, workspace);
  const [provider, ...rest] = options.model.split("/");
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: undefined,
    PI_CLAUDE_CODE_COMMAND: wrapper,
    TMUX: undefined,
  } as NodeJS.ProcessEnv;
  const stdoutPath = join(dir, "rpc.jsonl");
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--provider",
        provider as string,
        "--model",
        rest.join("/"),
        "--thinking",
        options.thinking,
        "--session-dir",
        join(dir, "sessions"),
        "--no-mcp",
      ],
      { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const dialogs: RunRecord["dialogs"] = [];
    let buffer = "";
    let raw = "";
    let stderr = "";
    let sent = false;
    let finished = false;
    const finish = (exit: string) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      child.stdin.end();
      setTimeout(() => child.kill("SIGTERM"), 5000).unref();
      writeFileSync(stdoutPath, raw);
      writeFileSync(join(dir, "stderr.txt"), stderr);
      done({
        caseId: testCase.id,
        arm,
        repetition,
        workspace,
        home,
        stdout: stdoutPath,
        dialogs,
        exit,
        ms: Date.now() - started,
      });
    };
    const timer = setTimeout(() => finish("timeout"), RUN_TIMEOUT_MS);
    const send = (record: unknown) =>
      child.stdin.write(`${JSON.stringify(record)}\n`);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => finish(`exit ${code}`));
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      raw += text;
      buffer += text;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          !sent &&
          record.type === "response" &&
          record.command === "get_state"
        ) {
          sent = true;
          send({
            id: "prompt-1",
            type: "prompt",
            message: testCase.prompt[arm],
          });
        } else if (record.type === "response" && record.command === "prompt") {
          const disposition = (
            record.data as { disposition?: string } | undefined
          )?.disposition;
          if (!record.success || disposition === "handled") {
            setTimeout(
              () => finish(record.success ? "handled" : "prompt-failed"),
              3000,
            );
          }
        } else if (record.type === "extension_ui_request") {
          const haystack = [record.title, record.message]
            .filter((part) => typeof part === "string")
            .join(" ")
            .toLowerCase();
          const rule = testCase.dialogs.find((candidate) =>
            haystack.includes(candidate.match.toLowerCase()),
          );
          const reply = answer(rule, record);
          if (reply) {
            dialogs.push({ method: record.method, title: record.title, reply });
            send({ type: "extension_ui_response", id: record.id, ...reply });
          }
        } else if (record.type === "agent_settled") {
          finish(record.aborted ? "aborted" : "settled");
        }
      }
    });
    send({ id: "state-0", type: "get_state" });
  });
}

// ---------- offline scoring ----------

interface ToolEvent {
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  order: number;
}

function jsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter((path) => path.endsWith(suffix) && statSync(path).isFile());
}

/** Main-session tool calls, in order, with error flags from their results. */
export function mainToolEvents(sessionDir: string): ToolEvent[] {
  const events: ToolEvent[] = [];
  const errors = new Map<string, boolean>();
  const order: { id: string; name: string; args: Record<string, unknown> }[] =
    [];
  for (const path of listFiles(sessionDir, ".jsonl")) {
    for (const entry of jsonl(path)) {
      const message = (entry as { message?: Record<string, unknown> }).message;
      if (entry.type !== "message" || !message) {
        continue;
      }
      if (message.role === "assistant") {
        for (const part of (message.content as
          | Record<string, unknown>[]
          | undefined) ?? []) {
          if (part.type === "toolCall") {
            order.push({
              id: part.id as string,
              name: part.name as string,
              args: (part.arguments as Record<string, unknown>) ?? {},
            });
          }
        }
      } else if (message.role === "toolResult") {
        errors.set(message.toolCallId as string, Boolean(message.isError));
      }
    }
  }
  for (const [index, call] of order.entries()) {
    events.push({
      ...call,
      isError: errors.get(call.id) ?? false,
      order: index,
    });
  }
  return events;
}

/** Final assistant text plus any custom report messages from the main session. */
export function reportText(sessionDir: string): string {
  const texts: string[] = [];
  for (const path of listFiles(sessionDir, ".jsonl")) {
    for (const entry of jsonl(path)) {
      const message = (entry as { message?: Record<string, unknown> }).message;
      if (
        entry.type === "custom_message" &&
        typeof entry.content === "string"
      ) {
        texts.push(entry.content);
      } else if (entry.type === "message" && message?.role === "assistant") {
        for (const part of (message.content as
          | Record<string, unknown>[]
          | undefined) ?? []) {
          if (part.type === "text" && typeof part.text === "string") {
            texts.push(part.text);
          }
        }
      } else if (
        entry.type === "message" &&
        message?.role === "custom" &&
        typeof message.content === "string"
      ) {
        texts.push(message.content);
      }
    }
  }
  return texts.join("\n\n");
}

/** Usage summed over main and child sessions. */
export function usage(dir: string): {
  cost: number;
  tokens: number;
  childRuns: number;
} {
  let cost = 0;
  let tokens = 0;
  const sessionFiles = [
    ...listFiles(join(dir, "sessions"), ".jsonl"),
    ...listFiles(join(dir, "home", ".pi", "agent", "subagents"), ".jsonl"),
  ];
  for (const path of sessionFiles) {
    for (const entry of jsonl(path)) {
      const message = (
        entry as {
          message?: {
            role?: string;
            usage?: { totalTokens?: number; cost?: { total?: number } };
          };
        }
      ).message;
      if (
        entry.type === "message" &&
        message?.role === "assistant" &&
        message.usage
      ) {
        tokens += message.usage.totalTokens ?? 0;
        cost += message.usage.cost?.total ?? 0;
      }
    }
  }
  const childRuns = listFiles(
    join(dir, "home", ".pi", "agent", "subagents"),
    "result.json",
  ).length;
  return { cost, tokens, childRuns };
}

const TEST_COMMAND = /\bbun\s+(run\s+)?test\b|\bnpm\s+test\b/u;
const EDIT_TOOLS = new Set(["edit", "write"]);

function changedPaths(workspace: string): string[] {
  return sh(workspace, "git", [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ])
    .out.split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/gu, ""));
}

function specLogs(workspace: string): Record<string, unknown>[][] {
  return listFiles(join(workspace, ".pi", "specs"), ".log.jsonl").map((path) =>
    jsonl(path),
  );
}

// Both runtimes append `done` only after every Done Criterion is verified
// (old: ledger completion; new: spec_log check of the last criterion).
function logDone(workspace: string): boolean {
  return specLogs(workspace).some((events) => events.at(-1)?.event === "done");
}

function probe(workspace: string, id: string): boolean {
  const spec = PROBES[id];
  if (!spec) {
    return false;
  }
  write(workspace, { [spec.path]: spec.content });
  return sh(workspace, "bun", ["test", spec.path]).code === 0;
}

const FINDING_PATTERNS: Record<string, RegExp> = {
  "finds-debug-bypass": /DEBUG/u,
  "finds-role-substring":
    /includes\(\s*["']admin["']\s*\)|substring|includes.{0,40}admin|admin.{0,40}includes/iu,
  "finds-sql-injection": /SQL\s*injection|injection|parameteri[sz]ed/iu,
};

export function score(
  testCase: PairedCase,
  dir: string,
  workspace: string,
): Record<string, boolean> {
  const sessions = join(dir, "sessions");
  const tools = mainToolEvents(sessions);
  const text = reportText(sessions);
  const changed = changedPaths(workspace);
  const result: Record<string, boolean> = {};
  for (const check of testCase.checks) {
    switch (check.id) {
      case "tests-pass":
        result[check.id] = sh(workspace, "bun", ["test"]).code === 0;
        break;
      case "scope":
        result[check.id] = changed.every((path) =>
          /^(src|tests|\.pi)\//u.test(path),
        );
        break;
      case "log-done":
        result[check.id] = logDone(workspace);
        break;
      case "main-verified": {
        const lastEdit = Math.max(
          -1,
          ...tools.filter((t) => EDIT_TOOLS.has(t.name)).map((t) => t.order),
        );
        const lastChild = Math.max(
          -1,
          ...tools.filter((t) => t.name === "subagent").map((t) => t.order),
        );
        const after = Math.max(lastEdit, lastChild);
        result[check.id] = tools.some(
          (t) =>
            t.name === "bash" &&
            t.order > after &&
            typeof t.args.command === "string" &&
            TEST_COMMAND.test(t.args.command),
        );
        break;
      }
      case "no-edits":
        result[check.id] =
          sh(workspace, "git", ["diff", "--quiet"]).code === 0 ||
          JSON.stringify(changed) ===
            JSON.stringify(Object.keys(testCase.fixture.dirty ?? {}).sort());
        // Dirty overlay is the review target; compare its bytes to the seed.
        for (const [path, content] of Object.entries(
          testCase.fixture.dirty ?? {},
        )) {
          if (readFileSync(join(workspace, path), "utf8") !== content) {
            result[check.id] = false;
          }
        }
        break;
      case "no-false-blocker":
        result[check.id] = !/\b(critical|high|blocking|blocker|P0|P1)\b/iu.test(
          text.replace(/no (critical|high|blocking)[^.\n]*/giu, ""),
        );
        break;
      default:
        if (check.id in PROBES) {
          result[check.id] = probe(workspace, check.id);
        } else if (check.id in FINDING_PATTERNS) {
          result[check.id] = (FINDING_PATTERNS[check.id] as RegExp).test(text);
        } else {
          throw new Error(`no scorer for check ${check.id}`);
        }
    }
  }
  return result;
}

// ---------- CLI ----------

function plan(options: Options) {
  const cases = options.caseIds.length
    ? CASES.filter((c) => options.caseIds.includes(c.id))
    : CASES;
  const runs: { testCase: PairedCase; arm: Arm; repetition: number }[] = [];
  for (const testCase of cases) {
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      // Alternate arm order per repetition to spread time-of-day and cache effects.
      const arms: Arm[] = repetition % 2 ? ["old", "new"] : ["new", "old"];
      for (const arm of arms) {
        runs.push({ testCase, arm, repetition });
      }
    }
  }
  return runs;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const runs = plan(options);
  if (options.dryRun || !options.live) {
    process.stdout.write(
      `${[
        `Planned ${runs.length} runs (${options.repetitions} repetition(s), model ${options.model}, thinking ${options.thinking}).`,
        ...runs.map((r) =>
          `- ${r.testCase.id} [${r.arm}] #${r.repetition}: ${r.testCase.prompt[r.arm]}`.slice(
            0,
            160,
          ),
        ),
        options.live
          ? ""
          : "No model calls made. Add --live with --old and --new to run.",
      ].join("\n")}\n`,
    );
    return;
  }
  if (!options.old || !options.new) {
    throw new Error("--live needs --old <worktree> and --new <worktree>");
  }
  mkdirSync(options.out, { recursive: true });
  const results: unknown[] = [];
  for (const run of runs) {
    const dir = join(
      options.out,
      `${run.testCase.id}-${run.arm}-${run.repetition}`,
    );
    const worktree = run.arm === "old" ? options.old : options.new;
    process.stderr.write(
      `running ${run.testCase.id} [${run.arm}] #${run.repetition}\n`,
    );
    const record = await runOne(
      run.testCase,
      run.arm,
      worktree,
      dir,
      options,
      run.repetition,
    );
    const checks = score(run.testCase, dir, record.workspace);
    const cost = usage(dir);
    const summary = { ...record, checks, ...cost };
    writeFileSync(join(dir, "result.json"), JSON.stringify(summary, null, 2));
    results.push(summary);
    process.stderr.write(
      `  ${record.exit} ${Math.round(record.ms / 1000)}s ${JSON.stringify(checks)}\n`,
    );
  }
  writeFileSync(
    join(options.out, "results.json"),
    JSON.stringify(results, null, 2),
  );
  process.stdout.write(`${options.out}/results.json\n`);
}

if (import.meta.main) {
  await main();
}
