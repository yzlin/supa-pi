import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const CHECK_DOMAINS = ["quality", "task", "tests", "evidence"] as const;
export const CORE_EVAL_BASE_PROMPT = `You are an expert coding assistant operating inside Pi.

Work inside the provided workspace. Inspect before editing. Make the smallest complete change. Preserve safety and type correctness. Verify changed behavior. Lead with the result and retain concrete evidence.`;
export type CheckDomain = (typeof CHECK_DOMAINS)[number];

const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const QUESTIONNAIRE_RESPONSES = [
  "Approve scoped fix",
  "Stop and clean probes",
] as const;
type QuestionnaireResponse = (typeof QUESTIONNAIRE_RESPONSES)[number];

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
  "questionnaire",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

interface CheckBase {
  domain: CheckDomain;
  weight: number;
}

interface ToolCallMatchCheck extends CheckBase {
  name: string;
  args: Record<string, unknown>;
  resultPattern: string;
  flags?: string;
  isError: boolean;
}

export type EvalCheck =
  | (CheckBase & { type: "outputIncludes"; value: string })
  | (CheckBase & { type: "outputMatches"; pattern: string; flags?: string })
  | (CheckBase & { type: "fileContains"; path: string; value: string })
  | (CheckBase & { type: "fileNotContains"; path: string; value: string })
  | (CheckBase & { type: "fileEquals"; path: string; value: string })
  | (CheckBase & { type: "toolCalled"; name: string })
  | (CheckBase & { type: "toolNotCalled"; name: string })
  | (ToolCallMatchCheck & { type: "toolCallMatches" })
  | (ToolCallMatchCheck & {
      type: "toolCallMatchesBeforeAssistantMatches";
      assistantPattern: string;
      assistantFlags?: string;
    })
  | (CheckBase & {
      type: "toolCalledAfter";
      name: string;
      after: string;
      args?: Record<string, unknown>;
    })
  | (CheckBase & { type: "questionnaireGate" })
  | (CheckBase & { type: "workspaceUnchanged" })
  | (CheckBase & { type: "workspaceChangesOnly"; paths: string[] });

export interface EvalCase {
  id: string;
  workload: string;
  promptPath: string;
  task: string;
  tools: ToolName[];
  questionnaireResponse?: QuestionnaireResponse;
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
  assistantTurn: number;
  isError?: boolean;
  resultText?: string;
  questionnaireResponse?: string;
}

export interface AssistantMessageRecord {
  text: string;
  assistantTurn: number;
}

interface ScoreInput {
  output: string;
  workspace: string;
  initialWorkspaceSnapshot?: string;
  toolCalls: ToolCallRecord[];
  assistantMessages?: AssistantMessageRecord[];
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
  baselineMetrics: RunMetrics;
  candidateMetrics: RunMetrics;
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
    case "fileEquals":
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
    case "toolNotCalled":
      assertNonEmptyString(value.name, `${label}.name`);
      return { ...base, type: value.type, name: value.name };
    case "toolCallMatches":
    case "toolCallMatchesBeforeAssistantMatches": {
      assertNonEmptyString(value.name, `${label}.name`);
      assertObject(value.args, `${label}.args`);
      assertNonEmptyString(value.resultPattern, `${label}.resultPattern`);
      if (value.flags !== undefined && typeof value.flags !== "string") {
        throw new Error(`${label}.flags must be a string`);
      }
      if (typeof value.isError !== "boolean") {
        throw new Error(`${label}.isError must be a boolean`);
      }
      new RegExp(value.resultPattern, value.flags as string | undefined);
      const parsedMatch = {
        ...base,
        name: value.name,
        args: value.args,
        resultPattern: value.resultPattern,
        flags: value.flags as string | undefined,
        isError: value.isError,
      };
      if (value.type === "toolCallMatchesBeforeAssistantMatches") {
        assertNonEmptyString(
          value.assistantPattern,
          `${label}.assistantPattern`
        );
        if (
          value.assistantFlags !== undefined &&
          typeof value.assistantFlags !== "string"
        ) {
          throw new Error(`${label}.assistantFlags must be a string`);
        }
        new RegExp(
          value.assistantPattern,
          value.assistantFlags as string | undefined
        );
        return {
          ...parsedMatch,
          type: value.type,
          assistantPattern: value.assistantPattern,
          assistantFlags: value.assistantFlags as string | undefined,
        };
      }
      return { ...parsedMatch, type: value.type };
    }
    case "toolCalledAfter": {
      assertNonEmptyString(value.name, `${label}.name`);
      assertNonEmptyString(value.after, `${label}.after`);
      let args: Record<string, unknown> | undefined;
      if (value.args !== undefined) {
        assertObject(value.args, `${label}.args`);
        args = value.args;
      }
      return {
        ...base,
        type: value.type,
        name: value.name,
        after: value.after,
        ...(args === undefined ? {} : { args }),
      };
    }
    case "questionnaireGate":
    case "workspaceUnchanged":
      return { ...base, type: value.type };
    case "workspaceChangesOnly":
      if (
        !Array.isArray(value.paths) ||
        value.paths.length === 0 ||
        !value.paths.every(
          (path) => typeof path === "string" && isSafeRelativePath(path)
        )
      ) {
        throw new Error(
          `${label}.paths must be safe repository-relative paths`
        );
      }
      return { ...base, type: value.type, paths: value.paths as string[] };
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
      caseValue.promptPath !== "skills/diagnose/SKILL.md" &&
      caseValue.promptPath !== "skills/showing-me/SKILL.md" &&
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
    if (
      caseValue.questionnaireResponse !== undefined &&
      caseValue.questionnaireResponse !== QUESTIONNAIRE_RESPONSES[0] &&
      caseValue.questionnaireResponse !== QUESTIONNAIRE_RESPONSES[1]
    ) {
      throw new Error(`${label}.questionnaireResponse is invalid`);
    }
    if (
      (caseValue.questionnaireResponse !== undefined) !==
      (caseValue.tools as unknown[]).includes("questionnaire")
    ) {
      throw new Error(
        `${label} must configure questionnaireResponse exactly when questionnaire is enabled`
      );
    }

    return {
      id: caseValue.id,
      workload: caseValue.workload,
      promptPath: caseValue.promptPath,
      task: caseValue.task,
      tools: caseValue.tools as ToolName[],
      questionnaireResponse: caseValue.questionnaireResponse,
      checks: caseValue.checks.map((check, checkIndex) =>
        parseCheck(check, `${label}.checks[${checkIndex}]`)
      ),
    };
  });

  return { version: 1, cases };
}

function sha256(content: string | Buffer): string {
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
  const baselineError = Buffer.concat(baselineErrors).toString("utf8");
  if (baselineExitCode !== 0) {
    const treeProcess = spawn(
      "git",
      ["ls-tree", "--name-only", baselineRevision, "--", promptPath],
      {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const treeOutput: Buffer[] = [];
    treeProcess.stdout.on("data", (chunk: Buffer) => treeOutput.push(chunk));
    const treeExitCode = await new Promise<number | null>(
      (resolveExit, reject) => {
        treeProcess.once("error", reject);
        treeProcess.once("close", resolveExit);
      }
    );
    const baselinePathExists =
      Buffer.concat(treeOutput).toString("utf8").trim().length > 0;
    if (treeExitCode !== 0 || baselinePathExists) {
      throw new Error(
        `cannot read ${baselineRevision}:${promptPath}: ${baselineError.trim() || "git show failed"}`
      );
    }
  }
  const baselineContent =
    baselineExitCode === 0
      ? Buffer.concat(baselineOutput).toString("utf8")
      : "";

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

export async function snapshotWorkspace(workspace: string): Promise<string> {
  const entries: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const path = resolve(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        entries.push(`link\0${relativePath}\0${await readlink(path)}`);
      } else if (stat.isDirectory()) {
        entries.push(`dir\0${relativePath}\0${stat.mode}`);
        await visit(path, relativePath);
      } else if (stat.isFile()) {
        entries.push(
          `file\0${relativePath}\0${stat.mode}\0${sha256(await readFile(path))}`
        );
      } else {
        entries.push(`other\0${relativePath}\0${stat.mode}`);
      }
    }
  }
  await visit(resolve(workspace), "");
  return JSON.stringify(entries);
}

function workspaceEntriesByPath(snapshot: string): Map<string, string> {
  return new Map(
    (JSON.parse(snapshot) as string[]).map((entry) => [
      entry.split("\0")[1] ?? "",
      entry,
    ])
  );
}

function includesRequiredArgs(
  recorded: Record<string, unknown>,
  required: Record<string, unknown>
): boolean {
  return Object.entries(required).every(
    ([key, value]) =>
      Object.hasOwn(recorded, key) && isDeepStrictEqual(recorded[key], value)
  );
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
    case "fileNotContains":
    case "fileEquals": {
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
      let passed = !contains;
      if (check.type === "fileEquals") {
        passed = content === check.value;
      } else if (check.type === "fileContains") {
        passed = contains;
      }
      return {
        check,
        passed,
        evidence: passed
          ? `${check.path} matched`
          : `${check.path} did not match`,
      };
    }
    case "toolCalled":
    case "toolNotCalled": {
      const count = input.toolCalls.filter(
        (call) => call.name === check.name
      ).length;
      const passed = check.type === "toolCalled" ? count > 0 : count === 0;
      return {
        check,
        passed,
        evidence: `${check.name} called ${count} time(s)`,
      };
    }
    case "toolCallMatches":
    case "toolCallMatchesBeforeAssistantMatches": {
      const matchingCalls = input.toolCalls.filter(
        (call) =>
          call.name === check.name &&
          includesRequiredArgs(call.args, check.args) &&
          call.isError === check.isError &&
          typeof call.resultText === "string" &&
          new RegExp(check.resultPattern, check.flags).test(call.resultText)
      );
      if (check.type === "toolCallMatchesBeforeAssistantMatches") {
        const firstMatchingTurn = Math.min(
          ...matchingCalls.map((call) => call.assistantTurn)
        );
        const prematureMessage = (input.assistantMessages ?? []).find(
          (message) =>
            message.assistantTurn <= firstMatchingTurn &&
            new RegExp(check.assistantPattern, check.assistantFlags).test(
              message.text
            )
        );
        const hasAssistantTrajectory = input.assistantMessages !== undefined;
        const passed =
          matchingCalls.length > 0 &&
          hasAssistantTrajectory &&
          !prematureMessage;
        let evidence = `${check.name} exact successful/expected result was missing`;
        if (passed) {
          evidence = `${check.name} matched before causal reasoning or diagnostic probes`;
        } else if (!hasAssistantTrajectory) {
          evidence = "assistant message trajectory was missing";
        } else if (prematureMessage) {
          evidence = `assistant reasoning or probe preceded matching ${check.name} call`;
        }
        return { check, passed, evidence };
      }
      const passed = matchingCalls.length > 0;
      return {
        check,
        passed,
        evidence: passed
          ? `${check.name} matched required arguments and exact result`
          : `${check.name} exact successful/expected result was missing`,
      };
    }
    case "toolCalledAfter": {
      const prerequisiteCall = input.toolCalls.find(
        (call) =>
          call.name === check.after &&
          !call.isError &&
          (call.name !== "questionnaire" ||
            call.questionnaireResponse === "Approve scoped fix")
      );
      const matchingCalls = input.toolCalls.filter(
        (call) =>
          call.name === check.name &&
          (check.args === undefined ||
            JSON.stringify(call.args) === JSON.stringify(check.args))
      );
      const prerequisiteTurn = prerequisiteCall?.assistantTurn;
      const passed =
        prerequisiteTurn !== undefined &&
        matchingCalls.length > 0 &&
        matchingCalls.every(
          (call) => !call.isError && call.assistantTurn > prerequisiteTurn
        );
      return {
        check,
        passed,
        evidence: passed
          ? `${check.name} succeeded in a later assistant turn than ${check.after}`
          : `${check.name} was missing, errored, or not in a later assistant turn than successful ${check.after}`,
      };
    }
    case "questionnaireGate": {
      const calls = input.toolCalls.filter(
        (call) => call.name === "questionnaire"
      );
      const questions = calls[0]?.args.questions;
      const question = Array.isArray(questions) ? questions[0] : undefined;
      const questionRecord =
        question && typeof question === "object"
          ? (question as Record<string, unknown>)
          : undefined;
      const options = questionRecord?.options;
      const labels = Array.isArray(options)
        ? options.map((option) =>
            option && typeof option === "object"
              ? (option as { label?: unknown }).label
              : undefined
          )
        : [];
      const passed =
        calls.length === 1 &&
        !calls[0]?.isError &&
        Array.isArray(questions) &&
        questions.length === 1 &&
        questionRecord?.multiSelect !== true &&
        labels.length === QUESTIONNAIRE_RESPONSES.length &&
        labels.every(
          (label, index) => label === QUESTIONNAIRE_RESPONSES[index]
        );
      return {
        check,
        passed,
        evidence: passed
          ? "questionnaire gate matched"
          : "questionnaire gate shape or options differed",
      };
    }
    case "workspaceUnchanged": {
      const current = await snapshotWorkspace(input.workspace);
      const passed =
        input.initialWorkspaceSnapshot !== undefined &&
        current === input.initialWorkspaceSnapshot;
      return {
        check,
        passed,
        evidence: passed ? "workspace unchanged" : "workspace changed",
      };
    }
    case "workspaceChangesOnly": {
      if (input.initialWorkspaceSnapshot === undefined) {
        return { check, passed: false, evidence: "initial snapshot missing" };
      }
      const before = workspaceEntriesByPath(input.initialWorkspaceSnapshot);
      const after = workspaceEntriesByPath(
        await snapshotWorkspace(input.workspace)
      );
      const changedPaths = [...new Set([...before.keys(), ...after.keys()])]
        .filter((path) => before.get(path) !== after.get(path))
        .sort();
      const expectedPaths = [...check.paths].sort();
      const passed =
        JSON.stringify(changedPaths) === JSON.stringify(expectedPaths);
      return {
        check,
        passed,
        evidence: `changed paths: ${changedPaths.join(", ") || "none"}`,
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

function averageMetrics(records: VariantRecord[]): RunMetrics {
  const metric = (select: (metrics: RunMetrics) => number): number =>
    average(records, (record) => select(record.metrics));
  return {
    inputTokens: metric((metrics) => metrics.inputTokens),
    outputTokens: metric((metrics) => metrics.outputTokens),
    reasoningTokens: metric((metrics) => metrics.reasoningTokens),
    cacheReadTokens: metric((metrics) => metrics.cacheReadTokens),
    cacheWriteTokens: metric((metrics) => metrics.cacheWriteTokens),
    costUsd: metric((metrics) => metrics.costUsd),
    latencyMs: metric((metrics) => metrics.latencyMs),
    turns: metric((metrics) => metrics.turns),
    toolCalls: metric((metrics) => metrics.toolCalls),
    toolErrors: metric((metrics) => metrics.toolErrors),
    recoveredToolErrors: metric((metrics) => metrics.recoveredToolErrors),
    retries: metric((metrics) => metrics.retries),
  };
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
  const baselineMetrics = averageMetrics(baseline);
  const candidateMetrics = averageMetrics(candidate);
  const metricDelta = (key: keyof RunMetrics): number =>
    candidateMetrics[key] - baselineMetrics[key];

  return {
    baselinePassRate,
    candidatePassRate,
    passRateDelta: candidatePassRate - baselinePassRate,
    baselineScore,
    candidateScore,
    scoreDelta: candidateScore - baselineScore,
    baselineMetrics,
    candidateMetrics,
    inputTokenDelta: metricDelta("inputTokens"),
    outputTokenDelta: metricDelta("outputTokens"),
    reasoningTokenDelta: metricDelta("reasoningTokens"),
    cacheReadTokenDelta: metricDelta("cacheReadTokens"),
    cacheWriteTokenDelta: metricDelta("cacheWriteTokens"),
    latencyMsDelta: metricDelta("latencyMs"),
    toolCallDelta: metricDelta("toolCalls"),
    turnDelta: metricDelta("turns"),
    retryDelta: metricDelta("retries"),
    costUsdDelta: metricDelta("costUsd"),
  };
}
