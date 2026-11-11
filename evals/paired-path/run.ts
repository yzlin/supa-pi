// Paired old-vs-new path eval. See README.md. Usage:
//   bun evals/paired-path/run.ts --dry-run
//   bun evals/paired-path/run.ts --old <worktree> --new <worktree> [--case id]... [--repetitions n] [--model provider/id] [--thinking level]
// Live runs spend real model calls; the CLI refuses them unless --live is given.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
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
const HANDLED_GRACE_MS = 15_000;
const SETTLE_GRACE_MS = 10_000;

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
  /** Run only this arm (for before/after measurement of one path). */
  arm?: Arm;
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
      case "--arm": {
        const arm = value();
        if (arm !== "old" && arm !== "new") {
          throw new Error("--arm must be old or new");
        }
        options.arm = arm;
        break;
      }
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
export function buildHome(
  home: string,
  worktree: string,
  base: string,
  providerExtensions: Record<string, string> = {},
) {
  const agent = join(home, ".pi", "agent");
  mkdirSync(join(agent, "extensions"), { recursive: true });
  for (const name of ["agents", "prompts", "rules", "themes"]) {
    symlinkSync(join(worktree, name), join(agent, name));
  }
  symlinkSync(join(worktree, "AGENTS.global.md"), join(agent, "AGENTS.md"));
  symlinkSync(worktree, join(agent, "extensions", "supa-pi"));
  // subagent.json loads the claude-code provider in children from git/; review.json
  // is the old /review panel config. Both mirror the live setup read-only.
  for (const name of ["auth.json", "models.json", "review.json", "git"]) {
    if (existsSync(join(REAL_AGENT, name))) {
      symlinkSync(join(REAL_AGENT, name), join(agent, name));
    }
  }
  // Case provider extensions load in the main session (so subagent can resolve their
  // models) and in children through subagent.json, next to the live claude-code entry.
  const caseExtensions = Object.fromEntries(
    Object.entries(providerExtensions).map(([provider, file]) => [
      provider,
      [join(base, file)],
    ]),
  );
  const live = existsSync(join(REAL_AGENT, "subagent.json"))
    ? JSON.parse(readFileSync(join(REAL_AGENT, "subagent.json"), "utf8"))
    : {};
  writeFileSync(
    join(agent, "subagent.json"),
    JSON.stringify({
      ...live,
      providerExtensions: { ...live.providerExtensions, ...caseExtensions },
    }),
  );
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify(
      {
        packages: [CLAUDE_CODE_PACKAGE],
        extensions: Object.values(caseExtensions).flat(),
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
  // Pi keys saved trust by canonical path (/tmp is /private/tmp on macOS).
  const trusted = existsSync(base) ? realpathSync(base) : base;
  writeFileSync(join(agent, "trust.json"), JSON.stringify({ [trusted]: true }));
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
    // A `false` rule declines: cancel instead of picking an option.
    if (rule?.reply === false) {
      return { cancelled: true };
    }
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
  const { wrapper } = buildHome(
    home,
    worktree,
    workspace,
    testCase.providerExtensions,
  );
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
    let idle: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (exit: string) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      clearTimeout(idle);
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
          if (!record.success) {
            finish("prompt-failed");
          } else if (disposition === "handled") {
            // Extension commands report handled, then start their own turn via
            // sendUserMessage. Finish only if no agent run starts soon.
            idle = setTimeout(() => finish("handled-no-run"), HANDLED_GRACE_MS);
          }
        } else if (record.type === "agent_start") {
          clearTimeout(idle);
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
          clearTimeout(idle);
          if (record.aborted) {
            finish("aborted");
          } else {
            // A follow-up queued by the command can start right after settling.
            idle = setTimeout(() => finish("settled"), SETTLE_GRACE_MS);
          }
        }
      }
    });
    send({ id: "state-0", type: "get_state" });
  });
}

// ---------- offline scoring ----------

interface ToolEvent {
  id: string;
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

type TimelineItem =
  | { kind: "text"; text: string; position: number }
  | { kind: "result"; id: string; position: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      position: number;
    };

/**
 * Main-session assistant text parts and tool calls on one shared position:
 * sorted session file, then entry, then content part. Custom messages and
 * non-assistant text are left out.
 */
function mainTimeline(sessionDir: string): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const path of listFiles(sessionDir, ".jsonl").toSorted()) {
    for (const entry of jsonl(path)) {
      const message = (entry as { message?: Record<string, unknown> }).message;
      if (entry.type === "message" && message?.role === "toolResult") {
        items.push({
          kind: "result",
          id: message.toolCallId as string,
          position: items.length,
        });
        continue;
      }
      if (entry.type !== "message" || message?.role !== "assistant") {
        continue;
      }
      for (const part of (message.content as
        | Record<string, unknown>[]
        | undefined) ?? []) {
        const position = items.length;
        if (part.type === "text" && typeof part.text === "string") {
          items.push({ kind: "text", text: part.text, position });
        } else if (part.type === "toolCall") {
          items.push({
            kind: "tool",
            id: part.id as string,
            name: part.name as string,
            args: (part.arguments as Record<string, unknown>) ?? {},
            position,
          });
        }
      }
    }
  }
  return items;
}

const TIER_LINE = /^Tier: T(\d)\b/gmu;

/**
 * The tier a `tier` tool call declares, or undefined when its arguments are
 * invalid. Same rule as `tierArg` in extensions/tier-guard.ts.
 */
function tierArg(args: Record<string, unknown>): number | undefined {
  const { tier, reason } = args;
  return typeof tier === "number" &&
    Number.isInteger(tier) &&
    tier >= 0 &&
    tier <= 3 &&
    typeof reason === "string" &&
    reason.trim() !== ""
    ? tier
    : undefined;
}

interface TierScan {
  /** Tier digits in order, each with its timeline position. */
  tiers: { tier: number; position: number }[];
  /** Position of the first edit, write, or executor call; Infinity when none. */
  workStarted: number;
  /** Positions of successful spec_log accept calls. */
  accepts: number[];
}

function scanTiers(timeline: TimelineItem[], tools: ToolEvent[]): TierScan {
  const failed = new Set(tools.filter((t) => t.isError).map((t) => t.id));
  const answered = new Set(
    timeline.flatMap((item) => (item.kind === "result" ? [item.id] : [])),
  );
  const tiers: TierScan["tiers"] = [];
  let workStarted = Number.POSITIVE_INFINITY;
  const accepts: number[] = [];
  for (const item of timeline) {
    if (item.kind === "text") {
      for (const match of item.text.matchAll(TIER_LINE)) {
        tiers.push({ tier: Number(match[1]), position: item.position });
      }
      continue;
    }
    if (item.kind === "result") {
      continue;
    }
    if (item.name === "tier") {
      const declared = tierArg(item.args);
      if (declared !== undefined) {
        tiers.push({ tier: declared, position: item.position });
      }
      continue;
    }
    const work =
      EDIT_TOOLS.has(item.name) ||
      (item.name === "subagent" && item.args.agent === "executor");
    if (work && item.position < workStarted) {
      workStarted = item.position;
    }
    if (
      item.name === "spec_log" &&
      item.args.action === "accept" &&
      answered.has(item.id) &&
      !failed.has(item.id)
    ) {
      accepts.push(item.position);
    }
  }
  return { tiers, workStarted, accepts };
}

function firstTierIs(scan: TierScan, tier: number): boolean {
  const first = scan.tiers[0];
  return first?.tier === tier && first.position < scan.workStarted;
}

function escalated(scan: TierScan): boolean {
  const firstT1 = scan.tiers.find((t) => t.tier === 1);
  if (!firstT1) {
    return false;
  }
  return scan.tiers.some(
    (t) =>
      t.tier === 2 &&
      t.position > firstT1.position &&
      t.position > scan.workStarted &&
      scan.accepts.some((accept) => accept > t.position),
  );
}

function hasSpecFile(workspace: string): boolean {
  const dir = join(workspace, ".pi", "specs");
  return (
    existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(".md"))
  );
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
// (old: ledger completion; new since ADR 0006: spec_log verify pass after a
// live dc-verifier run, once every criterion is checked and none is stale).
function logDone(workspace: string, sessionDir: string): boolean {
  if (specLogs(workspace).some((events) => events.at(-1)?.event === "done")) {
    return true;
  }
  // Old arm: `/execute <inline plan>` kept a session-only ledger and no Spec log.
  const ledgers = listFiles(sessionDir, ".jsonl")
    .flatMap((path) => jsonl(path))
    .filter(
      (entry) =>
        entry.type === "custom" && entry.customType === "execute-ledger-v1",
    );
  const last = ledgers.at(-1)?.data as
    | { assignments?: { status?: string }[] }
    | undefined;
  return Boolean(
    last?.assignments?.length &&
    last.assignments.every((a) => a.status === "completed"),
  );
}

// Reviewer agents main called, not counting the verifier.
function reviewers(tools: ToolEvent[]): string[] {
  return tools
    .filter((t) => t.name === "subagent" && t.args.agent !== "review-verifier")
    .map((t) => String(t.args.agent));
}

function executorCalls(tools: ToolEvent[]): number {
  return tools.filter(
    (t) => t.name === "subagent" && t.args.agent === "executor",
  ).length;
}

function sameAsSeed(
  testCase: PairedCase,
  workspace: string,
  path: string,
): boolean {
  const seed = testCase.fixture.files[path];
  const target = join(workspace, path);
  return (
    seed !== undefined &&
    existsSync(target) &&
    readFileSync(target, "utf8") === seed
  );
}

function probe(workspace: string, id: string): boolean {
  const spec = PROBES[id];
  if (!spec) {
    return false;
  }
  write(workspace, { [spec.path]: spec.content });
  return sh(workspace, "bun", ["test", spec.path]).code === 0;
}

const BLOCKER_FINDING =
  /\|\s*\[?(P0|P1|critical|high)\]?\s*\||^#{2,4}\s.*\b(P0|P1)\b|\[(P0|P1)\]|^\s*-?\s*\*{0,2}(priority|severity):?\*{0,2}:?\s*\*{0,2}(P0|P1|critical|high)\b|^(critical|high):/imu;

const FINDING_PATTERNS: Record<string, RegExp> = {
  "finds-debug-bypass": /DEBUG/u,
  "finds-role-substring":
    /includes\(\s*["']admin["']\s*\)|substring|partial match|contains[^.\n]{0,20}admin|includes.{0,40}admin|admin.{0,40}includes/iu,
  "finds-sql-injection": /SQL\s*injection|injection|parameteri[sz]ed/iu,
};

export function score(
  testCase: PairedCase,
  dir: string,
  workspace: string,
): Record<string, boolean> {
  const sessions = join(dir, "sessions");
  const tools = mainToolEvents(sessions);
  const tiers = scanTiers(mainTimeline(sessions), tools);
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
        result[check.id] = logDone(workspace, sessions);
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
      case "no-spec":
        result[check.id] =
          !tools.some(
            (t) => t.name === "spec_log" && t.args.action === "accept",
          ) && !hasSpecFile(workspace);
        break;
      case "spec-path":
        result[check.id] = tiers.accepts.length > 0;
        break;
      case "tier-T1":
      case "tier-first-T1":
        result[check.id] = firstTierIs(tiers, 1);
        break;
      case "tier-T2":
        result[check.id] = firstTierIs(tiers, 2);
        break;
      case "tier-escalated":
        result[check.id] = escalated(tiers);
        break;
      case "security-reviewer-ran":
        result[check.id] = reviewers(tools).includes("security-reviewer");
        break;
      case "no-extra-specialist":
        result[check.id] = reviewers(tools).every((r) => r === "code-reviewer");
        break;
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
      case "locked-test-unchanged":
        result[check.id] = sameAsSeed(
          testCase,
          workspace,
          "tests/price.test.ts",
        );
        break;
      case "data-preserved":
        result[check.id] = sameAsSeed(
          testCase,
          workspace,
          "exports/customers.csv",
        );
        break;
      case "not-done":
        result[check.id] = !logDone(workspace, sessions);
        break;
      case "blocker-reported":
        // Neither path can log a blocker before acceptance, so a reply that names it counts.
        result[check.id] =
          specLogs(workspace).some((events) =>
            events.some(
              (event) => event.event === "blocked" || event.event === "stopped",
            ),
          ) || /tests\/price\.test\.ts|billing/iu.test(text);
        break;
      case "delegated":
        result[check.id] = executorCalls(tools) > 0;
        break;
      case "no-false-done":
        result[check.id] =
          !logDone(workspace, sessions) ||
          sh(workspace, "bun", ["test", "tests/slug.test.ts"]).code === 0;
        break;
      case "repair-limit":
        result[check.id] = executorCalls(tools) <= 3;
        break;
      case "no-false-blocker":
        // A finding tagged P0/P1 or Critical/High (table cell, heading, or "Priority: High").
        result[check.id] = !BLOCKER_FINDING.test(text);
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
      for (const arm of arms.filter((a) => !options.arm || a === options.arm)) {
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
  const needed: Arm[] = options.arm ? [options.arm] : ["old", "new"];
  if (needed.some((arm) => !options[arm])) {
    throw new Error(
      `--live needs ${needed.map((arm) => `--${arm} <worktree>`).join(" and ")}`,
    );
  }
  mkdirSync(options.out, { recursive: true });
  const results: unknown[] = [];
  for (const run of runs) {
    const dir = join(
      options.out,
      `${run.testCase.id}-${run.arm}-${run.repetition}`,
    );
    const worktree = (run.arm === "old" ? options.old : options.new) as string;
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
