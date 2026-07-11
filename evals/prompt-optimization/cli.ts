import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  AuthStorage,
  ModelRegistry,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";

import {
  type AggregateDelta,
  aggregateVariants,
  CORE_EVAL_BASE_PROMPT,
  type EvalCorpus,
  loadPromptPair,
  type PromptPair,
  parseCorpus,
} from "./index";
import { type EvalVariant, type RunRecord, runVariant } from "./runner";

const DEFAULT_MODEL = "openai-codex/gpt-5.6-sol";
const DEFAULT_THINKING: ThinkingLevel = "high";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_TURNS = 20;

interface CliOptions {
  caseId?: string;
  help: boolean;
  model: string;
  thinking: ThinkingLevel;
  repetitions: number;
  timeoutMs: number;
  maxTurns: number;
}

interface EvalSummary {
  aggregate: AggregateDelta;
  cases: Record<string, AggregateDelta>;
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return number;
}

export function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    model: DEFAULT_MODEL,
    thinking: DEFAULT_THINKING,
    repetitions: 1,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxTurns: DEFAULT_MAX_TURNS,
  };
  const levels: ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case "--case":
        if (!value) {
          throw new Error("--case requires an id");
        }
        options.caseId = value;
        index += 1;
        break;
      case "--model":
        if (!value) {
          throw new Error("--model requires provider/model");
        }
        options.model = value;
        index += 1;
        break;
      case "--thinking":
        if (!levels.includes(value as ThinkingLevel)) {
          throw new Error(`--thinking must be one of: ${levels.join(", ")}`);
        }
        options.thinking = value as ThinkingLevel;
        index += 1;
        break;
      case "--repetitions":
        options.repetitions = parsePositiveInteger(value, flag);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(value, flag);
        index += 1;
        break;
      case "--max-turns":
        options.maxTurns = parsePositiveInteger(value, flag);
        index += 1;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }

  return options;
}

async function gitOutput(
  repositoryRoot: string,
  args: string[]
): Promise<string> {
  const process = spawn("git", args, {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  process.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  process.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    process.once("error", reject);
    process.once("close", resolveExit);
  });
  const output = Buffer.concat(stdout).toString("utf8");
  const errorOutput = Buffer.concat(stderr).toString("utf8");
  if (exitCode !== 0) {
    throw new Error(errorOutput.trim() || `git ${args.join(" ")} failed`);
  }
  return output;
}

export async function changedPromptPaths(
  repositoryRoot: string
): Promise<string[]> {
  const output = await gitOutput(repositoryRoot, [
    "diff",
    "--name-only",
    "HEAD",
    "--",
    "agents",
    "extensions/core-prompt/prompt.md",
  ]);
  return output
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean)
    .filter(
      (path) =>
        path === "extensions/core-prompt/prompt.md" ||
        (path.startsWith("agents/") && path.endsWith(".md"))
    );
}

function assertCorpusCoverage(
  corpus: EvalCorpus,
  changedPaths: string[]
): void {
  const coveredPaths = new Set(
    corpus.cases.map((evalCase) => evalCase.promptPath)
  );
  const missing = changedPaths.filter((path) => !coveredPaths.has(path));
  if (missing.length > 0) {
    throw new Error(
      `corpus does not cover changed prompts: ${missing.join(", ")}`
    );
  }
}

function successfulForAggregate(record: RunRecord): boolean {
  return record.taskPassed && (record.testPassed ?? true);
}

function aggregateRecords(records: RunRecord[]): AggregateDelta {
  const baseline = records
    .filter((record) => record.variant === "baseline")
    .map((record) => ({
      score: record.score.overall,
      metrics: record.metrics,
      succeeded: successfulForAggregate(record),
    }));
  const candidate = records
    .filter((record) => record.variant === "candidate")
    .map((record) => ({
      score: record.score.overall,
      metrics: record.metrics,
      succeeded: successfulForAggregate(record),
    }));
  return aggregateVariants(baseline, candidate);
}

function createSummary(records: RunRecord[]): EvalSummary {
  const caseIds = [...new Set(records.map((record) => record.caseId))];
  return {
    aggregate: aggregateRecords(records),
    cases: Object.fromEntries(
      caseIds.map((caseId) => [
        caseId,
        aggregateRecords(records.filter((record) => record.caseId === caseId)),
      ])
    ),
  };
}

function signed(value: number, digits = 2): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function summaryMarkdown(summary: EvalSummary): string {
  const aggregate = summary.aggregate;
  const lines = [
    "# Prompt eval summary",
    "",
    "Candidate minus baseline. Positive quality/pass deltas are better; negative latency/token/cost deltas are better.",
    "",
    "| Metric | Baseline | Candidate | Delta |",
    "| --- | ---: | ---: | ---: |",
    `| Pass rate | ${(aggregate.baselinePassRate * 100).toFixed(1)}% | ${(aggregate.candidatePassRate * 100).toFixed(1)}% | ${signed(aggregate.passRateDelta * 100, 1)} pp |`,
    `| Deterministic score | ${aggregate.baselineScore.toFixed(3)} | ${aggregate.candidateScore.toFixed(3)} | ${signed(aggregate.scoreDelta, 3)} |`,
    `| Input tokens | — | — | ${signed(aggregate.inputTokenDelta, 0)} |`,
    `| Output tokens | — | — | ${signed(aggregate.outputTokenDelta, 0)} |`,
    `| Reasoning tokens | — | — | ${signed(aggregate.reasoningTokenDelta, 0)} |`,
    `| Cache read tokens | — | — | ${signed(aggregate.cacheReadTokenDelta, 0)} |`,
    `| Cache write tokens | — | — | ${signed(aggregate.cacheWriteTokenDelta, 0)} |`,
    `| Latency | — | — | ${signed(aggregate.latencyMsDelta, 0)} ms |`,
    `| Tool calls | — | — | ${signed(aggregate.toolCallDelta, 1)} |`,
    `| Turns | — | — | ${signed(aggregate.turnDelta, 1)} |`,
    `| Retries | — | — | ${signed(aggregate.retryDelta, 1)} |`,
    `| Cost | — | — | ${signed(aggregate.costUsdDelta, 4)} USD |`,
    "",
    "## Per case",
    "",
    "| Case | Pass delta | Score delta | Input token delta | Latency delta |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const [caseId, result] of Object.entries(summary.cases)) {
    lines.push(
      `| ${caseId} | ${signed(result.passRateDelta * 100, 1)} pp | ${signed(result.scoreDelta, 3)} | ${signed(result.inputTokenDelta, 0)} | ${signed(result.latencyMsDelta, 0)} ms |`
    );
  }
  return `${lines.join("\n")}\n`;
}

async function writePromptSnapshot(
  outputDirectory: string,
  variant: EvalVariant,
  path: string,
  content: string
): Promise<void> {
  const target = join(outputDirectory, "prompts", variant, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

export async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: bun run eval:prompts -- [options]\n\nOptions:\n  --case <id>\n  --model <provider/model>\n  --thinking <level>\n  --repetitions <count>\n  --timeout-ms <milliseconds>\n  --max-turns <count>\n"
    );
    return;
  }
  const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
  const repositoryRoot = resolve(moduleDirectory, "../..");
  const corpusPath = join(moduleDirectory, "corpus.json");
  const fixturePath = join(moduleDirectory, "fixtures/sample-project");
  const corpusContent = await readFile(corpusPath, "utf8");
  const corpusSha256 = createHash("sha256").update(corpusContent).digest("hex");
  const corpus = parseCorpus(JSON.parse(corpusContent));
  const selectedCases = options.caseId
    ? corpus.cases.filter((evalCase) => evalCase.id === options.caseId)
    : corpus.cases;
  if (selectedCases.length === 0) {
    throw new Error(`unknown eval case: ${options.caseId}`);
  }
  if (!options.caseId) {
    assertCorpusCoverage(corpus, await changedPromptPaths(repositoryRoot));
  }
  const startedFromHead = (
    await gitOutput(repositoryRoot, ["rev-parse", "HEAD"])
  ).trim();
  const candidateDiff = await gitOutput(repositoryRoot, [
    "diff",
    "--binary",
    startedFromHead,
  ]);
  const candidateDiffSha256 = createHash("sha256")
    .update(candidateDiff)
    .digest("hex");

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const resolvedModel = resolveCliModel({
    cliModel: options.model,
    cliThinking: options.thinking,
    modelRegistry,
  });
  if (resolvedModel.error || !resolvedModel.model) {
    throw new Error(resolvedModel.error ?? `model not found: ${options.model}`);
  }
  const auth = await modelRegistry.getApiKeyAndHeaders(resolvedModel.model);
  if (!auth.ok) {
    throw new Error(auth.error);
  }

  const promptPairs = new Map<string, PromptPair>();
  for (const path of new Set(
    selectedCases.map((evalCase) => evalCase.promptPath)
  )) {
    const pair = await loadPromptPair(repositoryRoot, path, startedFromHead);
    if (pair.baseline.sha256 === pair.candidate.sha256) {
      throw new Error(
        `prompt is unchanged between HEAD and working tree: ${path}`
      );
    }
    promptPairs.set(path, pair);
  }

  const totalCalls = selectedCases.length * options.repetitions * 2;
  process.stdout.write(
    `Running ${totalCalls} live calls: ${selectedCases.length} case(s) × ${options.repetitions} repetition(s) × 2 variants\n`
  );

  const records: RunRecord[] = [];
  for (let caseIndex = 0; caseIndex < selectedCases.length; caseIndex += 1) {
    const evalCase = selectedCases[caseIndex];
    if (!evalCase) {
      continue;
    }
    const pair = promptPairs.get(evalCase.promptPath);
    if (!pair) {
      throw new Error(`missing prompt pair: ${evalCase.promptPath}`);
    }
    for (
      let repetition = 1;
      repetition <= options.repetitions;
      repetition += 1
    ) {
      const variants: EvalVariant[] =
        (caseIndex + repetition) % 2 === 0
          ? ["baseline", "candidate"]
          : ["candidate", "baseline"];
      for (const variant of variants) {
        process.stdout.write(
          `[${records.length + 1}/${totalCalls}] ${evalCase.id} ${variant} r${repetition}\n`
        );
        const snapshot = pair[variant];
        records.push(
          await runVariant({
            evalCase,
            variant,
            repetition,
            promptContent: snapshot.content,
            promptSha256: snapshot.sha256,
            fixturePath,
            model: resolvedModel.model,
            thinking: options.thinking,
            timeoutMs: options.timeoutMs,
            maxTurns: options.maxTurns,
            getApiKey: (provider) =>
              modelRegistry.getApiKeyForProvider(provider),
          })
        );
      }
    }
  }

  const endedAtHead = (
    await gitOutput(repositoryRoot, ["rev-parse", "HEAD"])
  ).trim();
  const endedAtDiff = await gitOutput(repositoryRoot, [
    "diff",
    "--binary",
    startedFromHead,
  ]);
  const endedAtDiffSha256 = createHash("sha256")
    .update(endedAtDiff)
    .digest("hex");
  const endedAtCorpusSha256 = createHash("sha256")
    .update(await readFile(corpusPath, "utf8"))
    .digest("hex");
  if (
    endedAtHead !== startedFromHead ||
    endedAtDiffSha256 !== candidateDiffSha256 ||
    endedAtCorpusSha256 !== corpusSha256
  ) {
    throw new Error(
      "repository prompts, HEAD, or eval corpus changed during the run; discard results and rerun"
    );
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const outputDirectory = join(
    repositoryRoot,
    ".pi",
    "evals",
    `${timestamp}-${startedFromHead.slice(0, 8)}`
  );
  await mkdir(join(outputDirectory, "runs"), { recursive: true });
  for (const [path, pair] of promptPairs) {
    await writePromptSnapshot(
      outputDirectory,
      "baseline",
      path,
      pair.baseline.content
    );
    await writePromptSnapshot(
      outputDirectory,
      "candidate",
      path,
      pair.candidate.content
    );
  }
  for (const record of records) {
    await writeFile(
      join(
        outputDirectory,
        "runs",
        `${record.caseId}-${record.variant}-r${record.repetition}.json`
      ),
      `${JSON.stringify(record, null, 2)}\n`
    );
  }
  const summary = createSummary(records);
  const manifest = {
    schemaVersion: 1,
    startedFromHead,
    candidateDiffSha256,
    corpusSha256,
    coreEvalBasePromptSha256: createHash("sha256")
      .update(CORE_EVAL_BASE_PROMPT)
      .digest("hex"),
    partial: Boolean(options.caseId),
    selectedCases: selectedCases.map((evalCase) => evalCase.id),
    model: `${resolvedModel.model.provider}/${resolvedModel.model.id}`,
    thinking: options.thinking,
    repetitions: options.repetitions,
    timeoutMs: options.timeoutMs,
    maxTurns: options.maxTurns,
    completedAt: new Date().toISOString(),
    promptHashes: Object.fromEntries(
      [...promptPairs].map(([path, pair]) => [
        path,
        {
          baseline: pair.baseline.sha256,
          candidate: pair.candidate.sha256,
        },
      ])
    ),
  };
  await Promise.all([
    writeFile(
      join(outputDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    ),
    writeFile(
      join(outputDirectory, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`
    ),
    writeFile(join(outputDirectory, "summary.md"), summaryMarkdown(summary)),
  ]);

  process.stdout.write(
    `\n${summaryMarkdown(summary)}\nArtifacts: ${outputDirectory}\n`
  );
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
