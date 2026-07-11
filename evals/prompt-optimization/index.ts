import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const CHECK_DOMAINS = ["quality", "task", "tests", "evidence"] as const;
export const CORE_EVAL_BASE_PROMPT = `You are an expert coding assistant operating inside Pi.

Work inside the provided workspace. Inspect before editing. Make the smallest complete change. Preserve safety and type correctness. Verify changed behavior. Lead with the result and retain concrete evidence.`;
export type CheckDomain = (typeof CHECK_DOMAINS)[number];

const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "Agent",
  "web_search",
  "fetch_content",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

interface CheckBase {
  domain: CheckDomain;
  weight: number;
}

export type EvalCheck =
  | (CheckBase & { type: "outputIncludes"; value: string })
  | (CheckBase & { type: "outputMatches"; pattern: string; flags?: string })
  | (CheckBase & { type: "fileContains"; path: string; value: string })
  | (CheckBase & { type: "fileNotContains"; path: string; value: string })
  | (CheckBase & { type: "toolCalled"; name: string });

export interface EvalCase {
  id: string;
  workload: string;
  promptPath: string;
  task: string;
  tools: ToolName[];
  checks: EvalCheck[];
}

export interface EvalCorpus {
  version: 1;
  cases: EvalCase[];
}

export interface PromptSnapshot {
  content: string;
  sha256: string;
}

export interface PromptPair {
  baseline: PromptSnapshot;
  candidate: PromptSnapshot;
}

export interface RunMetrics {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  latencyMs: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  recoveredToolErrors: number;
  retries: number;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  isError?: boolean;
}

interface ScoreInput {
  output: string;
  workspace: string;
  toolCalls: ToolCallRecord[];
}

export interface CheckResult {
  check: EvalCheck;
  passed: boolean;
  evidence: string;
}

export interface ScoreResult {
  overall: number;
  domains: Record<CheckDomain, number | null>;
  checks: CheckResult[];
}

interface VariantRecord {
  score: number;
  metrics: RunMetrics;
  succeeded: boolean;
}

export interface AggregateDelta {
  baselinePassRate: number;
  candidatePassRate: number;
  passRateDelta: number;
  baselineScore: number;
  candidateScore: number;
  scoreDelta: number;
  inputTokenDelta: number;
  outputTokenDelta: number;
  reasoningTokenDelta: number;
  cacheReadTokenDelta: number;
  cacheWriteTokenDelta: number;
  latencyMsDelta: number;
  toolCallDelta: number;
  turnDelta: number;
  retryDelta: number;
  costUsdDelta: number;
}

function assertObject(
  value: unknown,
  label: string
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNonEmptyString(
  value: unknown,
  label: string
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    path !== ".." &&
    !path.startsWith("../") &&
    !path.includes("/../")
  );
}

function parseCheck(value: unknown, label: string): EvalCheck {
  assertObject(value, label);
  assertNonEmptyString(value.type, `${label}.type`);
  if (!CHECK_DOMAINS.includes(value.domain as CheckDomain)) {
    throw new Error(`${label}.domain is invalid`);
  }
  if (typeof value.weight !== "number" || value.weight <= 0) {
    throw new Error(`${label}.weight must be positive`);
  }

  const base = {
    domain: value.domain as CheckDomain,
    weight: value.weight,
  };

  switch (value.type) {
    case "outputIncludes":
      assertNonEmptyString(value.value, `${label}.value`);
      return { ...base, type: value.type, value: value.value };
    case "outputMatches": {
      assertNonEmptyString(value.pattern, `${label}.pattern`);
      if (value.flags !== undefined && typeof value.flags !== "string") {
        throw new Error(`${label}.flags must be a string`);
      }
      new RegExp(value.pattern, value.flags as string | undefined);
      return {
        ...base,
        type: value.type,
        pattern: value.pattern,
        flags: value.flags as string | undefined,
      };
    }
    case "fileContains":
    case "fileNotContains":
      assertNonEmptyString(value.path, `${label}.path`);
      if (!isSafeRelativePath(value.path)) {
        throw new Error(`${label}.path must be repository-relative`);
      }
      assertNonEmptyString(value.value, `${label}.value`);
      return {
        ...base,
        type: value.type,
        path: value.path,
        value: value.value,
      };
    case "toolCalled":
      assertNonEmptyString(value.name, `${label}.name`);
      return { ...base, type: value.type, name: value.name };
    default:
      throw new Error(`${label}.type is unsupported`);
  }
}

export function parseCorpus(value: unknown): EvalCorpus {
  assertObject(value, "corpus");
  if (value.version !== 1) {
    throw new Error("corpus.version must be 1");
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error("corpus.cases must be a non-empty array");
  }

  const ids = new Set<string>();
  const cases = value.cases.map((caseValue, index): EvalCase => {
    const label = `corpus.cases[${index}]`;
    assertObject(caseValue, label);
    assertNonEmptyString(caseValue.id, `${label}.id`);
    if (!CASE_ID_PATTERN.test(caseValue.id)) {
      throw new Error(`${label}.id must be safe for artifact filenames`);
    }
    if (ids.has(caseValue.id)) {
      throw new Error(`duplicate case id: ${caseValue.id}`);
    }
    ids.add(caseValue.id);
    assertNonEmptyString(caseValue.workload, `${label}.workload`);
    assertNonEmptyString(caseValue.promptPath, `${label}.promptPath`);
    if (!isSafeRelativePath(caseValue.promptPath)) {
      throw new Error(`${label}.promptPath must be repository-relative`);
    }
    if (
      caseValue.promptPath !== "extensions/core-prompt/prompt.md" &&
      !caseValue.promptPath.startsWith("agents/")
    ) {
      throw new Error(`${label}.promptPath must target a SupaPi prompt`);
    }
    assertNonEmptyString(caseValue.task, `${label}.task`);
    if (
      !(
        Array.isArray(caseValue.tools) &&
        caseValue.tools.every((tool) => TOOL_NAMES.includes(tool as ToolName))
      )
    ) {
      throw new Error(`${label}.tools contains an unsupported tool`);
    }
    if (!Array.isArray(caseValue.checks) || caseValue.checks.length === 0) {
      throw new Error(`${label}.checks must be non-empty`);
    }

    return {
      id: caseValue.id,
      workload: caseValue.workload,
      promptPath: caseValue.promptPath,
      task: caseValue.task,
      tools: caseValue.tools as ToolName[],
      checks: caseValue.checks.map((check, checkIndex) =>
        parseCheck(check, `${label}.checks[${checkIndex}]`)
      ),
    };
  });

  return { version: 1, cases };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function loadPromptPair(
  repositoryRoot: string,
  promptPath: string,
  baselineRevision = "HEAD"
): Promise<PromptPair> {
  if (!isSafeRelativePath(promptPath)) {
    throw new Error(`promptPath must be repository-relative: ${promptPath}`);
  }
  const resolvedRepositoryRoot = await realpath(repositoryRoot);
  const candidatePath = resolve(resolvedRepositoryRoot, promptPath);
  const relativeCandidate = relative(resolvedRepositoryRoot, candidatePath);
  if (!(isSafeRelativePath(relativeCandidate) && existsSync(candidatePath))) {
    throw new Error(`candidate prompt does not exist: ${promptPath}`);
  }
  const candidateStat = await lstat(candidatePath);
  if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
    throw new Error(
      `candidate prompt must be a regular non-symlink file: ${promptPath}`
    );
  }
  const resolvedCandidatePath = await realpath(candidatePath);
  if (
    !isSafeRelativePath(relative(resolvedRepositoryRoot, resolvedCandidatePath))
  ) {
    throw new Error(`candidate prompt escapes repository root: ${promptPath}`);
  }

  const baselineProcess = spawn(
    "git",
    ["show", `${baselineRevision}:${promptPath}`],
    {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const baselineOutput: Buffer[] = [];
  const baselineErrors: Buffer[] = [];
  baselineProcess.stdout.on("data", (chunk: Buffer) =>
    baselineOutput.push(chunk)
  );
  baselineProcess.stderr.on("data", (chunk: Buffer) =>
    baselineErrors.push(chunk)
  );
  const [baselineExitCode, candidateContent] = await Promise.all([
    new Promise<number | null>((resolveExit, reject) => {
      baselineProcess.once("error", reject);
      baselineProcess.once("close", resolveExit);
    }),
    readFile(candidatePath, "utf8"),
  ]);
  const baselineContent = Buffer.concat(baselineOutput).toString("utf8");
  const baselineError = Buffer.concat(baselineErrors).toString("utf8");
  if (baselineExitCode !== 0) {
    throw new Error(
      `cannot read ${baselineRevision}:${promptPath}: ${baselineError.trim() || "git show failed"}`
    );
  }

  return {
    baseline: { content: baselineContent, sha256: sha256(baselineContent) },
    candidate: { content: candidateContent, sha256: sha256(candidateContent) },
  };
}

export function composePrompt(promptPath: string, content: string): string {
  if (promptPath === "extensions/core-prompt/prompt.md") {
    return `${CORE_EVAL_BASE_PROMPT}\n\n${content}`;
  }

  const { body } = parseFrontmatter(content);
  return [
    "You are a SupaPi subagent.",
    "Complete the assigned task autonomously. Use only the provided tools and workspace.",
    "Return a concise final answer with concrete evidence and verification results.",
    "",
    body.trim(),
  ].join("\n");
}

export function createEmptyMetrics(): RunMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    recoveredToolErrors: 0,
    retries: 0,
  };
}

function canonicalToolCall(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(args ?? {})}`;
}

export function reduceRunEvent(
  metrics: RunMetrics,
  event: Record<string, unknown>
): RunMetrics {
  const next = { ...metrics };
  if (event.type === "message_end") {
    const message = event.message as
      | {
          role?: string;
          usage?: Record<string, unknown>;
        }
      | undefined;
    if (message?.role === "assistant" && message.usage) {
      next.inputTokens += Number(message.usage.input ?? 0);
      next.outputTokens += Number(message.usage.output ?? 0);
      next.reasoningTokens += Number(message.usage.reasoning ?? 0);
      next.cacheReadTokens += Number(message.usage.cacheRead ?? 0);
      next.cacheWriteTokens += Number(message.usage.cacheWrite ?? 0);
      const cost = message.usage.cost as Record<string, unknown> | undefined;
      next.costUsd += Number(cost?.total ?? 0);
      next.turns += 1;
    }
  }
  if (event.type === "tool_execution_end") {
    next.toolCalls += 1;
    const key = canonicalToolCall(String(event.toolName), event.args);
    const failedKeys = new Set(
      (metrics as RunMetrics & { failedToolKeys?: string[] }).failedToolKeys ??
        []
    );
    if (event.isError === true) {
      next.toolErrors += 1;
      failedKeys.add(key);
    } else if (failedKeys.delete(key)) {
      next.recoveredToolErrors += 1;
    }
    (next as RunMetrics & { failedToolKeys?: string[] }).failedToolKeys = [
      ...failedKeys,
    ];
  }
  return next;
}

function safeWorkspacePath(workspace: string, path: string): string {
  if (!isSafeRelativePath(path)) {
    throw new Error(`unsafe check path: ${path}`);
  }
  const resolvedWorkspace = resolve(workspace);
  const filePath = resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, filePath);
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`check path escapes workspace: ${path}`);
  }
  return filePath;
}

async function scoreCheck(
  input: ScoreInput,
  check: EvalCheck
): Promise<CheckResult> {
  switch (check.type) {
    case "outputIncludes": {
      const passed = input.output.includes(check.value);
      return {
        check,
        passed,
        evidence: passed ? "output matched" : `missing: ${check.value}`,
      };
    }
    case "outputMatches": {
      const passed = new RegExp(check.pattern, check.flags).test(input.output);
      return {
        check,
        passed,
        evidence: passed
          ? "output matched"
          : `pattern missed: ${check.pattern}`,
      };
    }
    case "fileContains":
    case "fileNotContains": {
      const filePath = safeWorkspacePath(input.workspace, check.path);
      let content = "";
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        return {
          check,
          passed: false,
          evidence: `missing file: ${check.path}`,
        };
      }
      const contains = content.includes(check.value);
      const passed = check.type === "fileContains" ? contains : !contains;
      return {
        check,
        passed,
        evidence: passed
          ? `${check.path} matched`
          : `${check.path} did not match`,
      };
    }
    case "toolCalled": {
      const count = input.toolCalls.filter(
        (call) => call.name === check.name
      ).length;
      return {
        check,
        passed: count > 0,
        evidence: `${check.name} called ${count} time(s)`,
      };
    }
  }
}

export async function scoreRun(
  input: ScoreInput,
  checks: EvalCheck[]
): Promise<ScoreResult> {
  const results = await Promise.all(
    checks.map((check) => scoreCheck(input, check))
  );
  const possible = results.reduce(
    (sum, result) => sum + result.check.weight,
    0
  );
  const earned = results.reduce(
    (sum, result) => sum + (result.passed ? result.check.weight : 0),
    0
  );
  const domains = Object.fromEntries(
    CHECK_DOMAINS.map((domain) => {
      const matching = results.filter(
        (result) => result.check.domain === domain
      );
      const domainPossible = matching.reduce(
        (sum, result) => sum + result.check.weight,
        0
      );
      const domainEarned = matching.reduce(
        (sum, result) => sum + (result.passed ? result.check.weight : 0),
        0
      );
      return [
        domain,
        domainPossible === 0 ? null : domainEarned / domainPossible,
      ];
    })
  ) as Record<CheckDomain, number | null>;

  return { overall: earned / possible, domains, checks: results };
}

function average(
  records: VariantRecord[],
  select: (record: VariantRecord) => number
): number {
  return (
    records.reduce((sum, record) => sum + select(record), 0) / records.length
  );
}

export function aggregateVariants(
  baseline: VariantRecord[],
  candidate: VariantRecord[]
): AggregateDelta {
  if (baseline.length === 0 || candidate.length === 0) {
    throw new Error("both variants require at least one record");
  }
  const baselinePassRate = average(baseline, (record) =>
    Number(record.succeeded)
  );
  const candidatePassRate = average(candidate, (record) =>
    Number(record.succeeded)
  );
  const baselineScore = average(baseline, (record) => record.score);
  const candidateScore = average(candidate, (record) => record.score);
  const metricDelta = (select: (metrics: RunMetrics) => number): number =>
    average(candidate, (record) => select(record.metrics)) -
    average(baseline, (record) => select(record.metrics));

  return {
    baselinePassRate,
    candidatePassRate,
    passRateDelta: candidatePassRate - baselinePassRate,
    baselineScore,
    candidateScore,
    scoreDelta: candidateScore - baselineScore,
    inputTokenDelta: metricDelta((metrics) => metrics.inputTokens),
    outputTokenDelta: metricDelta((metrics) => metrics.outputTokens),
    reasoningTokenDelta: metricDelta((metrics) => metrics.reasoningTokens),
    cacheReadTokenDelta: metricDelta((metrics) => metrics.cacheReadTokens),
    cacheWriteTokenDelta: metricDelta((metrics) => metrics.cacheWriteTokens),
    latencyMsDelta: metricDelta((metrics) => metrics.latencyMs),
    toolCallDelta: metricDelta((metrics) => metrics.toolCalls),
    turnDelta: metricDelta((metrics) => metrics.turns),
    retryDelta: metricDelta((metrics) => metrics.retries),
    costUsdDelta: metricDelta((metrics) => metrics.costUsd),
  };
}
