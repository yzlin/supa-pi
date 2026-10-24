/// <reference types="bun" />
/**
 * Paired edit pilot: Pi built-in edit (baseline) vs tool-display unified edit
 * (candidate). Usage:
 *   bun evals/unified-edit-reliability/run.ts [--model provider/id] [--cases 01,02] [--concurrency 4]
 * Loads only the given model provider extension plus tool-display. Raw events
 * and summary.json go to evals/unified-edit-reliability/runs/<timestamp>/.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";

import { CASES, type EditCase } from "./cases";

type Arm = "baseline" | "candidate";

interface PiEvent {
  type?: string;
  toolName?: string;
  isError?: boolean;
  result?: { content?: Array<{ text?: string }> };
  message?: {
    role?: string;
    usage?: { output?: number; totalTokens?: number };
  };
}

interface CallResult {
  caseId: string;
  arm: Arm;
  model: string;
  requiresEdit: boolean;
  exitCode: number | null;
  timedOut: boolean;
  latencyMs: number;
  outcomeCorrect: boolean;
  firstAttemptSuccess: boolean;
  editCalls: number;
  failedEditCalls: number;
  writeCalls: number;
  toolCalls: number;
  firstEditError: string | null;
  mismatchedPaths: string[];
  outputTokens: number;
  totalTokens: number;
}

const REPO = join(import.meta.dir, "..", "..");
const TOOL_DISPLAY = join(REPO, "extensions", "tool-display", "index.ts");
const PROVIDER_EXTENSIONS: Record<string, string> = {
  "claude-bridge": join(
    homedir(),
    "dev",
    "yzlin",
    "pi-claude-bridge",
    "src",
    "index.ts",
  ),
  "claude-code": join(
    homedir(),
    ".pi",
    "agent",
    "git",
    "github.com",
    "yzlin",
    "pi-claude-code",
    "src",
    "index.ts",
  ),
};
const TIMEOUT_MS = 300_000;

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "claude-code/claude-sonnet-5-5" },
    cases: { type: "string" },
    concurrency: { type: "string", default: "4" },
  },
});

async function listTree(
  root: string,
  dir = root,
): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (
      dir === root &&
      (entry.name === ".pi" || entry.name === "events.jsonl")
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      Object.assign(tree, await listTree(root, full));
    } else {
      tree[relative(root, full)] = await readFile(full, "utf8");
    }
  }
  return tree;
}

async function runCall(
  editCase: EditCase,
  arm: Arm,
  model: string,
  outDir: string,
): Promise<CallResult> {
  const cwd = await mkdtemp(
    join(tmpdir(), `edit-pilot-${editCase.id}-${arm}-`),
  );
  for (const [path, content] of Object.entries(editCase.files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content, "utf8");
  }
  // Both arms load tool-display so only the edit tool differs.
  await mkdir(join(cwd, ".pi"));
  await writeFile(
    join(cwd, ".pi", "tool-display.json"),
    JSON.stringify({ tools: { edit: { enabled: arm === "candidate" } } }),
  );

  const prompt = `${editCase.prompt}\n\nFiles are in the current directory. Make the change with the available tools, then stop.`;
  const providerExtension = PROVIDER_EXTENSIONS[model.split("/")[0] ?? ""];
  const extensions = providerExtension ? ["-e", providerExtension] : [];
  const started = performance.now();
  const proc = Bun.spawn(
    [
      "pi",
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--no-extensions",
      ...extensions,
      "-e",
      TOOL_DISPLAY,
      "--model",
      model,
      "-t",
      "read,edit,write",
      prompt,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const latencyMs = Math.round(performance.now() - started);

  const stem = join(outDir, `${editCase.id}.${arm}`);
  await writeFile(`${stem}.events.jsonl`, stdout);
  if (stderr) {
    await writeFile(`${stem}.stderr.txt`, stderr);
  }

  let editCalls = 0;
  let failedEditCalls = 0;
  let writeCalls = 0;
  let toolCalls = 0;
  let firstEditError: string | null = null;
  let sawAssistantMessage = false;
  let outputTokens = 0;
  let totalTokens = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let event: PiEvent;
    try {
      event = JSON.parse(line) as PiEvent;
    } catch {
      continue;
    }
    if (event.type === "tool_execution_end") {
      toolCalls++;
      if (event.toolName === "write") {
        writeCalls++;
      }
      if (event.toolName === "edit") {
        editCalls++;
        if (event.isError) {
          failedEditCalls++;
          if (editCalls === 1) {
            firstEditError = String(
              event.result?.content?.[0]?.text ?? "",
            ).slice(0, 500);
          }
        }
      }
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      sawAssistantMessage = true;
      outputTokens += event.message.usage?.output ?? 0;
      totalTokens += event.message.usage?.totalTokens ?? 0;
    }
  }

  const actual = await listTree(cwd);
  const paths = new Set([
    ...Object.keys(actual),
    ...Object.keys(editCase.expected),
  ]);
  const mismatchedPaths = [...paths].filter(
    (path) => actual[path] !== editCase.expected[path],
  );
  const outcomeCorrect =
    mismatchedPaths.length === 0 &&
    !timedOut &&
    exitCode === 0 &&
    sawAssistantMessage;
  await writeFile(`${stem}.tree.json`, JSON.stringify(actual, null, 2));

  return {
    caseId: editCase.id,
    arm,
    model,
    requiresEdit: editCase.requiresEdit,
    exitCode,
    timedOut,
    latencyMs,
    outcomeCorrect,
    firstAttemptSuccess:
      outcomeCorrect &&
      failedEditCalls === 0 &&
      !(editCase.requiresEdit && editCalls === 0),
    editCalls,
    failedEditCalls,
    writeCalls,
    toolCalls,
    firstEditError,
    mismatchedPaths,
    outputTokens,
    totalTokens,
  };
}

function summarize(results: CallResult[], arm: Arm) {
  const rows = results.filter((result) => result.arm === arm);
  const count = (predicate: (row: CallResult) => boolean) =>
    rows.filter(predicate).length;
  const sum = (pick: (row: CallResult) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);
  return {
    calls: rows.length,
    outcomeCorrect: count((row) => row.outcomeCorrect),
    firstAttemptSuccess: count((row) => row.firstAttemptSuccess),
    firstAttemptRate: rows.length
      ? count((row) => row.firstAttemptSuccess) / rows.length
      : 0,
    failedEditCalls: sum((row) => row.failedEditCalls),
    editCalls: sum((row) => row.editCalls),
    writeCalls: sum((row) => row.writeCalls),
    writeOnlyEditCases: count(
      (row) => row.requiresEdit && row.editCalls === 0 && row.writeCalls > 0,
    ),
    toolCalls: sum((row) => row.toolCalls),
    outputTokens: sum((row) => row.outputTokens),
    medianLatencyMs: rows.map((row) => row.latencyMs).sort((a, b) => a - b)[
      Math.floor(rows.length / 2)
    ],
  };
}

const model = values.model;
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency <= 0) {
  throw new Error(
    `--concurrency must be a positive integer, got "${values.concurrency}"`,
  );
}
const wanted = values.cases?.split(",");
const selected = CASES.filter(
  (editCase) =>
    !wanted || wanted.some((prefix) => editCase.id.startsWith(prefix)),
);
const outDir = join(
  import.meta.dir,
  "runs",
  new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(outDir, { recursive: true });

const queue = selected.flatMap((editCase) =>
  (["baseline", "candidate"] as const).map((arm) => ({ editCase, arm })),
);
const results: CallResult[] = [];
const workers = Array.from({ length: concurrency }, async () => {
  while (queue.length > 0) {
    const job = queue.shift();
    if (!job) {
      return;
    }
    const result = await runCall(job.editCase, job.arm, model, outDir);
    results.push(result);
    console.log(
      `${result.caseId} ${result.arm.padEnd(9)} ${result.outcomeCorrect ? "ok  " : "FAIL"} first=${result.firstAttemptSuccess} edits=${result.editCalls} failed=${result.failedEditCalls} ${result.latencyMs}ms`,
    );
  }
});
await Promise.all(workers);

results.sort(
  (a, b) => a.caseId.localeCompare(b.caseId) || a.arm.localeCompare(b.arm),
);
const summary = {
  model,
  repoRevision: (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim(),
  baseline: summarize(results, "baseline"),
  candidate: summarize(results, "candidate"),
  results,
};
await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify(
    { baseline: summary.baseline, candidate: summary.candidate },
    null,
    2,
  ),
);
console.log(`artifacts: ${outDir}`);
