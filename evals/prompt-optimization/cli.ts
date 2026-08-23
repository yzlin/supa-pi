import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  ModelRegistry,
  ModelRuntime,
  resolveCliModel,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
  type AggregateDelta,
  aggregateVariants,
  CORE_EVAL_BASE_PROMPT,
  type EvalCase,
  type EvalCorpus,
  loadPromptPair,
  type PromptPair,
  parseCorpus,
  readStableContainedFile,
} from "./index";
import {
  type EvalVariant,
  planRuns,
  type RunRecord,
  runVariant,
} from "./runner";
import {
  aggregatePersistedTaskShapeRuns,
  assertTaskShapePlan,
  loadTaskShapeCorpus,
  TASK_SHAPE_PLANNED_CALLS,
  TASK_SHAPE_PROMPT_PATH,
  TASK_SHAPE_REPETITIONS,
  type TaskShapeAggregate,
} from "./task-shape";

const DEFAULT_MODEL = "openai-codex/gpt-5.6-sol";
export const TASK_SHAPE_CASE_IDS = loadTaskShapeCorpus().cases.map(
  (evalCase) => evalCase.id
);
const DEFAULT_THINKING: ThinkingLevel = "high";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_TURNS = 20;

interface CliOptions {
  caseIds: string[];
  help: boolean;
  model: string;
  modelExplicit: boolean;
  thinking: ThinkingLevel;
  candidateThinking?: ThinkingLevel;
  compareServiceTier: boolean;
  taskShapeSuite: boolean;
  repetitions: number;
  timeoutMs: number;
  maxTurns: number;
}

interface VariantConfig {
  promptContent: string;
  promptSha256: string;
  thinking: ThinkingLevel;
  serviceTier?: "default" | "priority";
}

type ComparisonKind = "prompt" | "reasoning" | "service-tier";
type PromptSource = "head" | "working-tree";

interface ComparisonArm {
  thinking: ThinkingLevel;
  promptSource: PromptSource;
  serviceTier?: "default" | "priority";
}

interface Comparison {
  kind: ComparisonKind;
  baseline: ComparisonArm;
  candidate: ComparisonArm;
}

interface ReasoningModelSupport {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

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
    caseIds: [],
    help: false,
    model: DEFAULT_MODEL,
    modelExplicit: false,
    thinking: DEFAULT_THINKING,
    compareServiceTier: false,
    taskShapeSuite: false,
    repetitions: 1,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxTurns: DEFAULT_MAX_TURNS,
  };
  let repetitionsExplicit = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case "--case":
        if (!value) {
          throw new Error("--case requires an id");
        }
        if (!options.caseIds.includes(value)) {
          options.caseIds.push(value);
        }
        index += 1;
        break;
      case "--model":
        if (!value) {
          throw new Error("--model requires provider/model");
        }
        options.model = value;
        options.modelExplicit = true;
        index += 1;
        break;
      case "--thinking":
        if (!THINKING_LEVELS.includes(value as ThinkingLevel)) {
          throw new Error(
            `--thinking must be one of: ${THINKING_LEVELS.join(", ")}`
          );
        }
        options.thinking = value as ThinkingLevel;
        index += 1;
        break;
      case "--compare-service-tier":
        options.compareServiceTier = true;
        break;
      case "--task-shape-suite":
        options.taskShapeSuite = true;
        break;
      case "--candidate-thinking":
        if (!THINKING_LEVELS.includes(value as ThinkingLevel)) {
          throw new Error(
            `--candidate-thinking must be one of: ${THINKING_LEVELS.join(", ")}`
          );
        }
        options.candidateThinking = value as ThinkingLevel;
        index += 1;
        break;
      case "--repetitions":
        options.repetitions = parsePositiveInteger(value, flag);
        repetitionsExplicit = true;
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

  if (options.taskShapeSuite) {
    if (options.caseIds.length > 0) {
      throw new Error("--task-shape-suite cannot be combined with --case");
    }
    if (options.compareServiceTier || options.candidateThinking) {
      throw new Error(
        "--task-shape-suite cannot be combined with paired comparison flags"
      );
    }
    if (repetitionsExplicit && options.repetitions !== TASK_SHAPE_REPETITIONS) {
      throw new Error("--task-shape-suite requires exactly 3 repetitions");
    }
    options.repetitions = TASK_SHAPE_REPETITIONS;
  }
  if (options.candidateThinking === options.thinking) {
    throw new Error("reasoning comparison requires different thinking levels");
  }
  if (options.compareServiceTier && options.candidateThinking) {
    throw new Error("cannot combine reasoning and service-tier comparisons");
  }
  if (options.compareServiceTier && options.repetitions % 2 !== 0) {
    throw new Error(
      "service-tier comparison requires an even repetition count to balance arm ordering"
    );
  }

  return options;
}

export function createVariantConfigs(
  pair: PromptPair,
  options: Pick<CliOptions, "thinking" | "candidateThinking"> & {
    compareServiceTier?: boolean;
  }
): Record<EvalVariant, VariantConfig> {
  if (options.compareServiceTier) {
    return {
      baseline: {
        promptContent: pair.candidate.content,
        promptSha256: pair.candidate.sha256,
        thinking: options.thinking,
        serviceTier: "default",
      },
      candidate: {
        promptContent: pair.candidate.content,
        promptSha256: pair.candidate.sha256,
        thinking: options.thinking,
        serviceTier: "priority",
      },
    };
  }

  if (options.candidateThinking) {
    return {
      baseline: {
        promptContent: pair.candidate.content,
        promptSha256: pair.candidate.sha256,
        thinking: options.thinking,
      },
      candidate: {
        promptContent: pair.candidate.content,
        promptSha256: pair.candidate.sha256,
        thinking: options.candidateThinking,
      },
    };
  }

  return {
    baseline: {
      promptContent: pair.baseline.content,
      promptSha256: pair.baseline.sha256,
      thinking: options.thinking,
    },
    candidate: {
      promptContent: pair.candidate.content,
      promptSha256: pair.candidate.sha256,
      thinking: options.thinking,
    },
  };
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

export async function snapshotPromptCandidates(
  repositoryRoot: string,
  promptPaths: string[]
): Promise<string> {
  const states = await Promise.resolve(
    [...new Set(promptPaths)].sort().map((promptPath) => {
      try {
        const content = readStableContainedFile(repositoryRoot, promptPath);
        return {
          path: promptPath,
          state: "file",
          sha256: createHash("sha256").update(content).digest("hex"),
        };
      } catch (error) {
        const cause =
          typeof error === "object" && error !== null && "cause" in error
            ? error.cause
            : error;
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return { path: promptPath, state: "missing" };
        }
        throw error;
      }
    })
  );
  return createHash("sha256").update(JSON.stringify(states)).digest("hex");
}

export async function changedPromptPaths(
  repositoryRoot: string
): Promise<string[]> {
  const supportedFiles = [
    "extensions/core-prompt/prompt.md",
    "skills/diagnose/SKILL.md",
    "skills/showing-me/SKILL.md",
    "skills/tdd-workflow/SKILL.md",
  ];
  const pathspecs = ["agents", ...supportedFiles];
  const outputs = await Promise.all([
    gitOutput(repositoryRoot, [
      "diff",
      "--name-only",
      "HEAD",
      "--",
      ...pathspecs,
    ]),
    gitOutput(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      ...pathspecs,
    ]),
  ]);
  return [
    ...new Set(
      outputs
        .join("\n")
        .split("\n")
        .map((path) => path.trim())
        .filter(Boolean)
        .filter(
          (path) =>
            supportedFiles.includes(path) ||
            (path.startsWith("agents/") &&
              path.endsWith(".md") &&
              existsSync(resolve(repositoryRoot, path)))
        )
    ),
  ].sort();
}

export async function establishChangedPromptSnapshot(
  repositoryRoot: string,
  operations: {
    discover?: typeof changedPromptPaths;
    snapshot?: typeof snapshotPromptCandidates;
  } = {}
): Promise<{ paths: string[]; stateSha256: string }> {
  const discover = operations.discover ?? changedPromptPaths;
  const snapshot = operations.snapshot ?? snapshotPromptCandidates;
  const paths = await discover(repositoryRoot);
  const stateSha256 = await snapshot(repositoryRoot, paths);
  const pathsAfterSnapshot = await discover(repositoryRoot);
  if (JSON.stringify(pathsAfterSnapshot) !== JSON.stringify(paths)) {
    throw new Error(
      "changed prompt path set changed while establishing the protected startup snapshot; discard results and rerun"
    );
  }
  return { paths, stateSha256 };
}

export async function changedPromptSnapshotMatches(
  repositoryRoot: string,
  startingPaths: string[],
  startingStateSha256: string
): Promise<boolean> {
  const currentPaths = await changedPromptPaths(repositoryRoot);
  if (JSON.stringify(currentPaths) !== JSON.stringify(startingPaths)) {
    return false;
  }
  const currentState = await snapshotPromptCandidates(
    repositoryRoot,
    currentPaths
  );
  const pathsAfterSnapshot = await changedPromptPaths(repositoryRoot);
  return (
    JSON.stringify(pathsAfterSnapshot) === JSON.stringify(currentPaths) &&
    currentState === startingStateSha256
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

export function plannedCallMessage(
  caseCount: number,
  repetitions: number,
  singleArm: boolean
): string {
  const arms = singleArm ? 1 : 2;
  const armLabel = singleArm ? "candidate arm" : "variants";
  return `Running ${caseCount * repetitions * arms} live calls: ${caseCount} case(s) × ${repetitions} repetition(s) × ${arms} ${armLabel}\n`;
}

export function modelSelectionRecord(
  selectedAtStart: string,
  resolved: string,
  explicit: boolean
) {
  return {
    source: explicit ? ("cli" as const) : ("configured-primary" as const),
    selectedAtStart,
    resolved,
  };
}

export function singleArmManifestFields(plannedCalls: number) {
  return {
    mode: "task-shape-suite" as const,
    plannedCalls,
    arm: {
      variant: "candidate" as const,
      promptSource: "working-tree" as const,
    },
  };
}

export function configuredPrimaryModel(
  explicitModel: string | undefined,
  settings: Pick<SettingsManager, "getDefaultProvider" | "getDefaultModel">
): string {
  if (explicitModel) {
    return explicitModel;
  }
  const provider = settings.getDefaultProvider();
  const model = settings.getDefaultModel();
  if (!(provider && model)) {
    throw new Error(
      "--task-shape-suite requires a configured primary model or --model"
    );
  }
  return `${provider}/${model}`;
}

function signed(value: number, digits = 2): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export function createComparison(options: CliOptions): Comparison {
  if (options.compareServiceTier) {
    return {
      kind: "service-tier",
      baseline: {
        thinking: options.thinking,
        promptSource: "working-tree",
        serviceTier: "default",
      },
      candidate: {
        thinking: options.thinking,
        promptSource: "working-tree",
        serviceTier: "priority",
      },
    };
  }

  return {
    kind: options.candidateThinking ? "reasoning" : "prompt",
    baseline: {
      thinking: options.thinking,
      promptSource: options.candidateThinking ? "working-tree" : "head",
    },
    candidate: {
      thinking: options.candidateThinking ?? options.thinking,
      promptSource: "working-tree",
    },
  };
}

export function validateServiceTierComparison(
  model: { api?: string },
  comparison: Comparison
): void {
  if (comparison.kind !== "service-tier") {
    return;
  }
  if (model.api !== "openai-codex-responses") {
    throw new Error(
      "service-tier comparison currently requires an openai-codex Responses model"
    );
  }
}

export function validateServiceTierEvidence(
  records: readonly Pick<
    RunRecord,
    "caseId" | "variant" | "repetition" | "payloadServiceTier"
  >[],
  comparison: Comparison
): void {
  if (comparison.kind !== "service-tier") {
    return;
  }
  for (const record of records) {
    const expected = record.variant === "candidate" ? "priority" : "absent";
    if (record.payloadServiceTier !== expected) {
      throw new Error(
        `invalid service-tier payload evidence for ${record.caseId} ${record.variant} r${record.repetition}: expected ${expected}, got ${record.payloadServiceTier ?? "missing"}`
      );
    }
  }
}

export function validateReasoningComparison(
  model: ReasoningModelSupport,
  comparison: Comparison
): void {
  if (comparison.kind !== "reasoning") {
    return;
  }
  if (!model.reasoning) {
    throw new Error("selected model does not support reasoning");
  }

  const baselineLevel = comparison.baseline.thinking;
  const candidateLevel = comparison.candidate.thinking;
  const baselineEffort = model.thinkingLevelMap?.[baselineLevel];
  const candidateEffort = model.thinkingLevelMap?.[candidateLevel];
  if (baselineEffort === null) {
    throw new Error(
      `selected model does not support baseline thinking level: ${baselineLevel}`
    );
  }
  if (candidateEffort === null) {
    throw new Error(
      `selected model does not support candidate thinking level: ${candidateLevel}`
    );
  }
  if (
    typeof baselineEffort === "string" &&
    baselineEffort === candidateEffort
  ) {
    throw new Error(
      `${baselineLevel} and ${candidateLevel} map to the same provider effort`
    );
  }
}

export function taskShapeSummaryMarkdown(summary: TaskShapeAggregate): string {
  return `${[
    "# Task-shape suite summary",
    "",
    "Single candidate arm; no baseline or deltas were computed.",
    "",
    "| Gate | Result |",
    "| --- | ---: |",
    `| Planned 24 candidate calls | ${summary.plannedRunsValid ? "PASS" : "FAIL"} |`,
    `| Structurally valid runs | ${summary.structuralValidRuns}/24 |`,
    `| Correct classification and shape | ${summary.classificationCorrectRuns}/24 |`,
    `| Invalid/oversized TDD attempts | ${summary.invalidOrOversizedTddAttempts} |`,
    `| Aggregate | ${summary.gates.passed ? "PASS" : "FAIL"} |`,
  ].join("\n")}\n`;
}

function summaryMarkdown(summary: EvalSummary, comparison: Comparison): string {
  const aggregate = summary.aggregate;
  const baseline = aggregate.baselineMetrics;
  const candidate = aggregate.candidateMetrics;
  let title = "Prompt";
  if (comparison.kind === "reasoning") {
    title = "Reasoning";
  } else if (comparison.kind === "service-tier") {
    title = "Service tier";
  }
  const baselineLabel =
    comparison.kind === "service-tier"
      ? `Baseline (${comparison.baseline.serviceTier})`
      : `Baseline (${comparison.baseline.thinking})`;
  const candidateLabel =
    comparison.kind === "service-tier"
      ? `Candidate (${comparison.candidate.serviceTier})`
      : `Candidate (${comparison.candidate.thinking})`;
  const lines = [
    `# ${title} eval summary`,
    "",
    "Candidate minus baseline. Positive quality/pass deltas are better; negative latency/token/cost deltas are better.",
    "",
    `| Metric | ${baselineLabel} | ${candidateLabel} | Delta |`,
    "| --- | ---: | ---: | ---: |",
    `| Pass rate | ${(aggregate.baselinePassRate * 100).toFixed(1)}% | ${(aggregate.candidatePassRate * 100).toFixed(1)}% | ${signed(aggregate.passRateDelta * 100, 1)} pp |`,
    `| Deterministic score | ${aggregate.baselineScore.toFixed(3)} | ${aggregate.candidateScore.toFixed(3)} | ${signed(aggregate.scoreDelta, 3)} |`,
    `| Input tokens | ${baseline.inputTokens.toFixed(0)} | ${candidate.inputTokens.toFixed(0)} | ${signed(aggregate.inputTokenDelta, 0)} |`,
    `| Output tokens | ${baseline.outputTokens.toFixed(0)} | ${candidate.outputTokens.toFixed(0)} | ${signed(aggregate.outputTokenDelta, 0)} |`,
    `| Reasoning tokens | ${baseline.reasoningTokens.toFixed(0)} | ${candidate.reasoningTokens.toFixed(0)} | ${signed(aggregate.reasoningTokenDelta, 0)} |`,
    `| Cache read tokens | ${baseline.cacheReadTokens.toFixed(0)} | ${candidate.cacheReadTokens.toFixed(0)} | ${signed(aggregate.cacheReadTokenDelta, 0)} |`,
    `| Cache write tokens | ${baseline.cacheWriteTokens.toFixed(0)} | ${candidate.cacheWriteTokens.toFixed(0)} | ${signed(aggregate.cacheWriteTokenDelta, 0)} |`,
    `| Latency | ${baseline.latencyMs.toFixed(0)} ms | ${candidate.latencyMs.toFixed(0)} ms | ${signed(aggregate.latencyMsDelta, 0)} ms |`,
    `| Tool calls | ${baseline.toolCalls.toFixed(1)} | ${candidate.toolCalls.toFixed(1)} | ${signed(aggregate.toolCallDelta, 1)} |`,
    `| Turns | ${baseline.turns.toFixed(1)} | ${candidate.turns.toFixed(1)} | ${signed(aggregate.turnDelta, 1)} |`,
    `| Retries | ${baseline.retries.toFixed(1)} | ${candidate.retries.toFixed(1)} | ${signed(aggregate.retryDelta, 1)} |`,
    `| Cost | ${baseline.costUsd.toFixed(4)} USD | ${candidate.costUsd.toFixed(4)} USD | ${signed(aggregate.costUsdDelta, 4)} USD |`,
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
      "Usage: bun run eval:prompts -- [options]\n\nOptions:\n  --case <id> (repeatable)\n  --model <provider/model>\n  --thinking <level>\n  --candidate-thinking <level>\n  --compare-service-tier\n  --task-shape-suite (8 cases × 3 repetitions, candidate only)\n  --repetitions <count>\n  --timeout-ms <milliseconds>\n  --max-turns <count>\n"
    );
    return;
  }
  const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
  const repositoryRoot = resolve(moduleDirectory, "../..");
  const corpusPath = join(
    moduleDirectory,
    options.taskShapeSuite ? "task-shape-corpus.json" : "corpus.json"
  );
  const fixturePath = join(moduleDirectory, "fixtures/sample-project");
  const corpusContent = await readFile(corpusPath, "utf8");
  const corpusSha256 = createHash("sha256").update(corpusContent).digest("hex");
  const standardCorpus = parseCorpus(
    JSON.parse(await readFile(join(moduleDirectory, "corpus.json"), "utf8"))
  );
  const taskShapeCorpus = options.taskShapeSuite
    ? loadTaskShapeCorpus()
    : undefined;
  if (taskShapeCorpus) {
    assertTaskShapePlan(taskShapeCorpus.cases.length, options.repetitions);
  }
  const taskShapeCasesById = new Map(
    (taskShapeCorpus?.cases ?? []).map((evalCase) => [evalCase.id, evalCase])
  );
  const suiteEvalCases: EvalCase[] = (taskShapeCorpus?.cases ?? []).map(
    (evalCase) => ({
      id: evalCase.id,
      workload: "tool-heavy orchestration",
      promptPath: TASK_SHAPE_PROMPT_PATH,
      task: evalCase.task,
      tools: [
        "TaskCreate",
        "TaskUpdate",
        "TaskList",
        "TaskGet",
        "execute_checkpoint",
        "execute_tasks",
      ],
      checks: [
        {
          type: "workspaceUnchanged" as const,
          domain: "tests" as const,
          weight: 1,
        },
      ],
    })
  );
  const activeCases = options.taskShapeSuite
    ? suiteEvalCases
    : standardCorpus.cases;
  const casesById = new Map(
    activeCases.map((evalCase) => [evalCase.id, evalCase])
  );
  const unknownCaseIds = options.caseIds.filter(
    (caseId) => !casesById.has(caseId)
  );
  if (unknownCaseIds.length > 0) {
    throw new Error(`unknown eval case: ${unknownCaseIds.join(", ")}`);
  }
  const requestedCaseIds = options.taskShapeSuite
    ? [...TASK_SHAPE_CASE_IDS]
    : options.caseIds;
  const selectedCases =
    requestedCaseIds.length > 0
      ? requestedCaseIds.map((caseId) => {
          const evalCase = casesById.get(caseId);
          if (!evalCase) {
            throw new Error(`unknown eval case: ${caseId}`);
          }
          return evalCase;
        })
      : activeCases;
  const {
    paths: startingChangedPromptPaths,
    stateSha256: startingChangedPromptStateSha256,
  } = await establishChangedPromptSnapshot(repositoryRoot);
  if (options.caseIds.length === 0 && !options.taskShapeSuite) {
    assertCorpusCoverage(standardCorpus, startingChangedPromptPaths);
  }
  const selectedPromptPaths = [
    ...new Set(selectedCases.map((evalCase) => evalCase.promptPath)),
  ].sort();
  const comparison = createComparison(options);
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
  const candidatePromptStateSha256 = await snapshotPromptCandidates(
    repositoryRoot,
    selectedPromptPaths
  );

  const modelRuntime = await ModelRuntime.create();
  const modelRegistry = new ModelRegistry(modelRuntime);
  const settingsManager = SettingsManager.create(repositoryRoot);
  const selectedModel = options.taskShapeSuite
    ? configuredPrimaryModel(
        options.modelExplicit ? options.model : undefined,
        settingsManager
      )
    : options.model;
  const resolvedModel = resolveCliModel({
    cliModel: selectedModel,
    cliThinking: options.thinking,
    modelRuntime,
  });
  if (resolvedModel.error || !resolvedModel.model) {
    throw new Error(resolvedModel.error ?? `model not found: ${selectedModel}`);
  }
  validateReasoningComparison(resolvedModel.model, comparison);
  validateServiceTierComparison(resolvedModel.model, comparison);
  const auth = await modelRegistry.getApiKeyAndHeaders(resolvedModel.model);
  if (auth.ok === false) {
    throw new Error(auth.error);
  }

  const variantConfigs = new Map<string, Record<EvalVariant, VariantConfig>>();
  for (const path of selectedPromptPaths) {
    let pair: PromptPair;
    if (options.taskShapeSuite) {
      const content = readStableContainedFile(repositoryRoot, path).toString(
        "utf8"
      );
      const candidate = {
        content,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
      pair = { baseline: candidate, candidate };
    } else {
      pair = await loadPromptPair(repositoryRoot, path, startedFromHead);
    }
    if (
      !options.taskShapeSuite &&
      comparison.kind === "prompt" &&
      pair.baseline.sha256 === pair.candidate.sha256
    ) {
      throw new Error(
        `prompt is unchanged between HEAD and working tree: ${path}`
      );
    }
    variantConfigs.set(path, createVariantConfigs(pair, options));
  }

  const plannedRuns = planRuns(
    selectedCases.map((evalCase) => evalCase.id),
    options.repetitions,
    options.taskShapeSuite
  );
  const totalCalls = plannedRuns.length;
  if (options.taskShapeSuite && totalCalls !== TASK_SHAPE_PLANNED_CALLS) {
    throw new Error("Task-shape suite did not plan exactly 24 calls");
  }
  process.stdout.write(
    plannedCallMessage(
      selectedCases.length,
      options.repetitions,
      options.taskShapeSuite
    )
  );

  const records: RunRecord[] = [];
  for (const plannedRun of plannedRuns) {
    const evalCase = casesById.get(plannedRun.caseId);
    if (!evalCase) {
      throw new Error(`missing planned eval case: ${plannedRun.caseId}`);
    }
    const configs = variantConfigs.get(evalCase.promptPath);
    if (!configs) {
      throw new Error(`missing variant configs: ${evalCase.promptPath}`);
    }
    const { variant, repetition } = plannedRun;
    process.stdout.write(
      `[${records.length + 1}/${totalCalls}] ${evalCase.id} ${variant} r${repetition}\n`
    );
    const config = configs[variant];
    records.push(
      await runVariant({
        evalCase,
        variant,
        repetition,
        promptContent: config.promptContent,
        promptSha256: config.promptSha256,
        fixturePath,
        model: resolvedModel.model,
        thinking: config.thinking,
        ...(config.serviceTier ? { serviceTier: config.serviceTier } : {}),
        timeoutMs: options.timeoutMs,
        maxTurns: options.maxTurns,
        getApiKey: (provider) => modelRegistry.getApiKeyForProvider(provider),
        ...(options.taskShapeSuite
          ? { taskShapeCase: taskShapeCasesById.get(evalCase.id) }
          : {}),
      })
    );
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
  const endedAtPromptStateSha256 = await snapshotPromptCandidates(
    repositoryRoot,
    selectedPromptPaths
  );
  const changedPromptsUnchanged = await changedPromptSnapshotMatches(
    repositoryRoot,
    startingChangedPromptPaths,
    startingChangedPromptStateSha256
  );
  if (
    endedAtHead !== startedFromHead ||
    endedAtDiffSha256 !== candidateDiffSha256 ||
    endedAtCorpusSha256 !== corpusSha256 ||
    endedAtPromptStateSha256 !== candidatePromptStateSha256 ||
    !changedPromptsUnchanged
  ) {
    throw new Error(
      "repository prompts, HEAD, or eval corpus changed during the run; discard results and rerun"
    );
  }
  if (!options.taskShapeSuite) {
    validateServiceTierEvidence(records, comparison);
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const outputDirectory = join(
    repositoryRoot,
    ".pi",
    "evals",
    `${timestamp}-${startedFromHead.slice(0, 8)}`
  );
  await mkdir(join(outputDirectory, "runs"), { recursive: true });
  for (const [path, configs] of variantConfigs) {
    if (!options.taskShapeSuite) {
      await writePromptSnapshot(
        outputDirectory,
        "baseline",
        path,
        configs.baseline.promptContent
      );
    }
    await writePromptSnapshot(
      outputDirectory,
      "candidate",
      path,
      configs.candidate.promptContent
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
  const summary = options.taskShapeSuite
    ? await aggregatePersistedTaskShapeRuns(
        join(outputDirectory, "runs"),
        taskShapeCorpus!
      )
    : createSummary(records);
  const summaryMarkdownContent = options.taskShapeSuite
    ? taskShapeSummaryMarkdown(summary as TaskShapeAggregate)
    : summaryMarkdown(summary as EvalSummary, comparison);
  const manifest = {
    schemaVersion: 1,
    startedFromHead,
    candidateDiffSha256,
    candidatePromptStateSha256,
    changedPromptPaths: startingChangedPromptPaths,
    changedPromptStateSha256: startingChangedPromptStateSha256,
    corpusSha256,
    coreEvalBasePromptSha256: createHash("sha256")
      .update(CORE_EVAL_BASE_PROMPT)
      .digest("hex"),
    partial: options.caseIds.length > 0,
    ...(options.taskShapeSuite
      ? singleArmManifestFields(totalCalls)
      : { mode: "paired", plannedCalls: totalCalls }),
    selectedCases: selectedCases.map((evalCase) => evalCase.id),
    model: `${resolvedModel.model.provider}/${resolvedModel.model.id}`,
    ...(options.taskShapeSuite
      ? {
          modelSelection: modelSelectionRecord(
            selectedModel,
            `${resolvedModel.model.provider}/${resolvedModel.model.id}`,
            options.modelExplicit
          ),
        }
      : {}),
    thinking: options.thinking,
    candidateThinking: options.candidateThinking,
    ...(options.taskShapeSuite
      ? {}
      : { compareServiceTier: options.compareServiceTier, comparison }),
    repetitions: options.repetitions,
    timeoutMs: options.timeoutMs,
    maxTurns: options.maxTurns,
    completedAt: new Date().toISOString(),
    promptHashes: Object.fromEntries(
      [...variantConfigs].map(([path, configs]) => [
        path,
        options.taskShapeSuite
          ? { candidate: configs.candidate.promptSha256 }
          : {
              baseline: configs.baseline.promptSha256,
              candidate: configs.candidate.promptSha256,
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
    writeFile(join(outputDirectory, "summary.md"), summaryMarkdownContent),
  ]);

  process.stdout.write(
    `\n${summaryMarkdownContent}\nArtifacts: ${outputDirectory}\n`
  );
  if (options.taskShapeSuite && !(summary as TaskShapeAggregate).gates.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
