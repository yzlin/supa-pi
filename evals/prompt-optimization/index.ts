import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { composeTddExecutorPrompt } from "../../extensions/execute/executor-prompt";
import {
  type TrustedFixtureRegression,
  validateTddEvidence,
} from "../../extensions/execute/tdd-evidence";

export const CHECK_DOMAINS = ["quality", "task", "tests", "evidence"] as const;
export const CORE_EVAL_BASE_PROMPT = `You are an expert coding assistant operating inside Pi.

Work inside the provided workspace. Inspect before editing. Make the smallest complete change. Preserve safety and type correctness. Verify changed behavior. Lead with the result and retain concrete evidence.`;
export type CheckDomain = (typeof CHECK_DOMAINS)[number];

const TDD_WORKFLOW_PATH = "skills/tdd-workflow/SKILL.md";
const EXECUTOR_ROLE_PROMPT = parseFrontmatter(
  readFileSync(new URL("../../agents/executor.md", import.meta.url), "utf8")
).body.trim();

const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const LEADING_DOT_SLASH_PATTERN = /^(?:\.\/)+/;
const FIXTURE_README_ADMIN_PATTERN =
  /admin access requires the `?admin`? role/i;
const FIXTURE_README_GREP_PATTERN =
  /(?:^|\n)(?:\.\/)?README\.md(?::\d+:|-\d+-)[^\n]*admin access requires the `?admin`? role/i;
const FIXTURE_AUTH_ADMIN_PATTERN =
  /(?:role\s*===?\s*["']admin["']|canAccessAdminPanel)/i;
const DEBUG_PATTERN = /debug/i;
const LINE_PATTERN = /\r?\n/;
const TABLE_SEPARATOR_PATTERN = /^:?-{3,}:?$/;
const README_ADMIN_CLAIM_PATTERN =
  /(?:admin(?:\s+access|\s+role)?[^|\r\n]{0,32}(?:requires?|required)|(?:requires?|required)[^|\r\n]{0,32}(?:admin|role\s*:\s*admin))/i;
const AUTH_IMPLEMENTATION_CLAIM_PATTERN =
  /(?:canAccessAdminPanel|debug[^|\r\n]{0,32}(?:bypass|exception|return(?:s)?\s+true|grant)|(?:bypass|exception)[^|\r\n]{0,16}debug|role[^|\r\n]{0,24}admin|admin[^|\r\n]{0,24}(?:role|check|grant))/i;
const AUTH_CONTRADICTION_PATTERN =
  /(?:\balways\b[^|\r\n]{0,24}\bden(?:y|ied)|\bnever\b[^|\r\n]{0,24}(?:grant|allow)|README[^|\r\n]{0,24}\bbypass)/i;
const README_WRONG_SOURCE_PATTERN = /\b(?:debug|bypass|exception)\b/i;
const TEXT_FENCE_PATTERN = /```(?:text)?\s*([\s\S]*?)```/i;
const DIAGRAM_CONNECTOR_PATTERN = /(?:→|->|├|└)/;
const FIXTURE_PATH_TOKEN_PATTERN =
  /(?:[a-z]:[\\/]|(?:\.{1,2}[\\/])+|[\\/])?(?:[a-z0-9_.-]+[\\/])*[a-z0-9_.-]+\.(?:md|ts)(?::\d+)?(?:#L\d+)?/gi;
const FIXTURE_MARKDOWN_TARGET_PATTERN =
  /^(?:\.\/)*(README\.md|src\/auth\.ts)(?::\d+|#L\d+(?:-L\d+)?)?$/i;
const LINE_NUMBER_SUFFIX_PATTERN = /(?::\d+|#L\d+)$/i;
const UNAVAILABLE_SUCCESS_CLAIM_PATTERN =
  /\b(?:fixed|complete(?:d)?|success(?:ful(?:ly)?)?|tests? pass(?:ed)?)\b/i;
const EXECUTION_CAPABILITY_PATTERN = /(?:bash|command|execution|test runner)/i;
const UNAVAILABLE_PATTERN = /(?:unavailable|missing|cannot|can't|no access)/i;
const AUTH_BYPASS_PATTERN = /return\s+true|bypass/i;
const DIRECT_DECISION_QUESTION_PATTERN =
  /\b(?:should|which|would you|do you want|can you (?:choose|confirm))\b[^?]*\?/i;
const REFERENTIAL_DECISION_QUESTION_PATTERN =
  /\bwhich\s+(?:(?:of\s+)?(?:these\s+)?(?:options?|alternatives?|approaches?)|one)\b/i;
const DIRECT_DECISION_IMPERATIVE_PATTERN =
  /(?:^|[.!?]\s+)((?:please\s+)?(?:confirm|choose|decide|clarify|specify|tell me)\b.*?)(?=[.!?](?:\s|$)|$)/i;
const AUTH_DECISION_CONTEXT_PATTERN =
  /\b(?:admin|auth(?:entication|orization)?|access|canAccessAdminPanel|security)\b/i;
const AUTH_DECISION_SCOPE_PATTERN =
  /\b(?:admin|auth(?:entication|orization)?|canAccessAdminPanel|security)\b/i;
const AUTH_DECISION_BEHAVIOR_PATTERN = /\b(?:debug|bypass|internal|role)\b/i;
const AUTH_DECISION_RULE_PATTERN =
  /\b(?:auth(?:entication|orization)?|security)\s+(?:policy|rule)\b/i;
const REFERENTIAL_POLICY_QUESTION_PATTERN =
  /\bwhich\s+policy\s+(?:(?:should\s+)?apply\b|governs?\s+(?:this\b|here\b))/i;
const REFERENTIAL_POLICY_IMPERATIVE_PATTERN =
  /\bpolicy\s+(?:I|we)\s+should\s+implement\b/i;
const OPTION_LINE_PATTERN = /^\s*(?:[-*]|\d+[.)]|option\s+\d+:)\s+/i;
const ADMIN_ANSWER_PATTERN = /admin(?:istrator)?(?: role)?|role[^.\r\n]*admin/i;
const ASK_RESPONSES = ["Approve scoped fix", "Stop and clean probes"] as const;
type AskResponse = (typeof ASK_RESPONSES)[number];

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
  "ask",
  "structured_output",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "execute_checkpoint",
  "execute_tasks",
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

interface ToolCallSequenceCheck extends CheckBase {
  name: string;
  args: Record<string, unknown>;
  firstResultPattern: string;
  firstIsError: boolean;
  secondResultPattern: string;
  secondIsError: boolean;
  flags?: string;
}

interface ToolCallCountCheck extends CheckBase {
  type: "toolCallCount";
  name: string;
  args?: Record<string, unknown>;
  min?: number;
  max?: number;
}

export type EvalCheck =
  | (CheckBase & { type: "outputIncludes"; value: string })
  | (CheckBase & { type: "outputMatches"; pattern: string; flags?: string })
  | (CheckBase & { type: "fileContains"; path: string; value: string })
  | (CheckBase & { type: "fileNotContains"; path: string; value: string })
  | (CheckBase & { type: "fileEquals"; path: string; value: string })
  | (CheckBase & { type: "toolCalled"; name: string })
  | (CheckBase & { type: "toolNotCalled"; name: string })
  | ToolCallCountCheck
  | (ToolCallMatchCheck & { type: "toolCallMatches" })
  | (ToolCallSequenceCheck & { type: "toolCallSequence" })
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
  | (CheckBase & { type: "askGate" })
  | (CheckBase & { type: "authPolicyClarification" })
  | (CheckBase & {
      type: "fixtureAdminGrounding";
      source: "readme" | "readme-or-auth";
      visual: boolean;
    })
  | (CheckBase & { type: "unavailableExecutionResult" })
  | (CheckBase & { type: "workspaceUnchanged" })
  | (CheckBase & {
      type: "structuredOutput";
      expectedStatus?: "done" | "blocked" | "needs_followup";
    })
  | (CheckBase & {
      type: "tddEvidence";
      trustedFixtureRegression?: TrustedFixtureRegression;
    })
  | (CheckBase & { type: "workspaceChangesOnly"; paths: string[] });

export interface EvalCase {
  id: string;
  workload: string;
  promptPath: string;
  task: string;
  tools: ToolName[];
  askResponse?: AskResponse;
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
  startOrder?: number;
  endOrder?: number;
  isError?: boolean;
  resultText?: string;
  askResponse?: string;
  mutationTargets?: string[];
  hasTestTargets?: boolean;
  hasProductionTargets?: boolean;
  mutationAmbiguous?: boolean;
  rustWriteContent?: "production" | "test" | "unavailable";
  editOldSnippet?: string;
  editNewSnippet?: string;
  editDeltaTruncated?: boolean;
  regressionIntent?: string[];
  regressionTitles?: string[];
  mutationDelta?: Array<{
    path: string;
    status: "changed" | "created" | "deleted";
  }>;
  mutationProven?: boolean;
  executionDeniedBeforeStart?: boolean;
}

export interface AssistantMessageRecord {
  text: string;
  assistantTurn: number;
}

interface ScoreInput {
  output: string;
  workspace: string;
  taskIntent?: string;
  initialWorkspaceSnapshot?: string;
  toolCalls: ToolCallRecord[];
  assistantMessages?: AssistantMessageRecord[];
  trajectoryErrors?: string[];
  availableTools?: string[];
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
    case "toolCallCount": {
      assertNonEmptyString(value.name, `${label}.name`);
      let args: Record<string, unknown> | undefined;
      if (value.args !== undefined) {
        assertObject(value.args, `${label}.args`);
        args = value.args;
      }
      const validBound = (bound: unknown): bound is number =>
        Number.isSafeInteger(bound) && Number(bound) >= 0;
      const rawMin = value.min;
      const rawMax = value.max;
      if (rawMin === undefined && rawMax === undefined) {
        throw new Error(`${label} requires min or max`);
      }
      let min: number | undefined;
      if (rawMin !== undefined) {
        if (!validBound(rawMin)) {
          throw new Error(`${label}.min must be a non-negative safe integer`);
        }
        min = rawMin;
      }
      let max: number | undefined;
      if (rawMax !== undefined) {
        if (!validBound(rawMax)) {
          throw new Error(`${label}.max must be a non-negative safe integer`);
        }
        max = rawMax;
      }
      if (min !== undefined && max !== undefined && min > max) {
        throw new Error(`${label}.min must not exceed max`);
      }
      return {
        ...base,
        type: value.type,
        name: value.name,
        ...(args === undefined ? {} : { args }),
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      };
    }
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
    case "toolCallSequence": {
      assertNonEmptyString(value.name, `${label}.name`);
      assertObject(value.args, `${label}.args`);
      assertNonEmptyString(
        value.firstResultPattern,
        `${label}.firstResultPattern`
      );
      assertNonEmptyString(
        value.secondResultPattern,
        `${label}.secondResultPattern`
      );
      if (
        typeof value.firstIsError !== "boolean" ||
        typeof value.secondIsError !== "boolean"
      ) {
        throw new Error(`${label} sequence error expectations must be boolean`);
      }
      if (value.flags !== undefined && typeof value.flags !== "string") {
        throw new Error(`${label}.flags must be a string`);
      }
      new RegExp(value.firstResultPattern, value.flags as string | undefined);
      new RegExp(value.secondResultPattern, value.flags as string | undefined);
      return {
        ...base,
        type: value.type,
        name: value.name,
        args: value.args,
        firstResultPattern: value.firstResultPattern,
        firstIsError: value.firstIsError,
        secondResultPattern: value.secondResultPattern,
        secondIsError: value.secondIsError,
        flags: value.flags as string | undefined,
      };
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
    case "askGate":
    case "authPolicyClarification":
    case "unavailableExecutionResult":
    case "workspaceUnchanged":
      return { ...base, type: value.type };
    case "tddEvidence": {
      if (value.trustedFixtureRegression === undefined) {
        return { ...base, type: value.type };
      }
      assertObject(
        value.trustedFixtureRegression,
        `${label}.trustedFixtureRegression`
      );
      if (
        !isDeepStrictEqual(Object.keys(value.trustedFixtureRegression).sort(), [
          "command",
          "redOutputIdentity",
        ])
      ) {
        throw new Error(
          `${label}.trustedFixtureRegression must contain only command and redOutputIdentity`
        );
      }
      assertNonEmptyString(
        value.trustedFixtureRegression.command,
        `${label}.trustedFixtureRegression.command`
      );
      assertNonEmptyString(
        value.trustedFixtureRegression.redOutputIdentity,
        `${label}.trustedFixtureRegression.redOutputIdentity`
      );
      return {
        ...base,
        type: value.type,
        trustedFixtureRegression: {
          command: value.trustedFixtureRegression.command,
          redOutputIdentity: value.trustedFixtureRegression.redOutputIdentity,
        },
      };
    }
    case "fixtureAdminGrounding":
      if (!["readme", "readme-or-auth"].includes(String(value.source))) {
        throw new Error(`${label}.source is invalid`);
      }
      if (typeof value.visual !== "boolean") {
        throw new Error(`${label}.visual must be a boolean`);
      }
      return {
        ...base,
        type: value.type,
        source: value.source as "readme" | "readme-or-auth",
        visual: value.visual,
      };
    case "structuredOutput":
      if (
        value.expectedStatus !== undefined &&
        !["done", "blocked", "needs_followup"].includes(
          String(value.expectedStatus)
        )
      ) {
        throw new Error(`${label}.expectedStatus is invalid`);
      }
      return {
        ...base,
        type: value.type,
        expectedStatus: value.expectedStatus as
          | "done"
          | "blocked"
          | "needs_followup"
          | undefined,
      };
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
      caseValue.promptPath !== "skills/tdd-workflow/SKILL.md" &&
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
      caseValue.askResponse !== undefined &&
      caseValue.askResponse !== ASK_RESPONSES[0] &&
      caseValue.askResponse !== ASK_RESPONSES[1]
    ) {
      throw new Error(`${label}.askResponse is invalid`);
    }
    if (
      (caseValue.askResponse !== undefined) !==
      (caseValue.tools as unknown[]).includes("ask")
    ) {
      throw new Error(
        `${label} must configure askResponse exactly when ask is enabled`
      );
    }

    return {
      id: caseValue.id,
      workload: caseValue.workload,
      promptPath: caseValue.promptPath,
      task: caseValue.task,
      tools: caseValue.tools as ToolName[],
      askResponse: caseValue.askResponse as AskResponse | undefined,
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

export function readStableContainedFile(
  repositoryRoot: string,
  relativePath: string
): Buffer {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw new Error("O_NOFOLLOW is required for prompt reads");
  }
  const root = realpathSync(repositoryRoot);
  const absolute = resolve(root, relativePath);
  if (!isSafeRelativePath(relative(root, absolute))) {
    throw new Error(`file escapes repository root: ${relativePath}`);
  }
  let descriptor: number | undefined;
  try {
    const pathBefore = lstatSync(absolute);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
      throw new Error(
        `file must be a regular non-symlink file: ${relativePath}`
      );
    }
    // biome-ignore lint/suspicious/noBitwiseOperators: open(2) flags are bitmasks.
    descriptor = openSync(absolute, fsConstants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      realpathSync(absolute) !== absolute
    ) {
      throw new Error(`file changed before read: ${relativePath}`);
    }
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(
        descriptor,
        content,
        offset,
        content.length - offset,
        offset
      );
      if (count <= 0) {
        throw new Error(`file changed while reading: ${relativePath}`);
      }
      offset += count;
    }
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(absolute);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      realpathSync(absolute) !== absolute
    ) {
      throw new Error(`file changed while reading: ${relativePath}`);
    }
    return content;
  } catch (error) {
    throw new Error(`cannot safely read ${relativePath}`, { cause: error });
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
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
  if (!isSafeRelativePath(relativeCandidate)) {
    throw new Error(`candidate prompt escapes repository root: ${promptPath}`);
  }
  const candidateContent = readStableContainedFile(
    resolvedRepositoryRoot,
    promptPath
  ).toString("utf8");

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
  const baselineExitCode = await new Promise<number | null>(
    (resolveExit, reject) => {
      baselineProcess.once("error", reject);
      baselineProcess.once("close", resolveExit);
    }
  );
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

export function composeEvalRequest(
  promptPath: string,
  content: string,
  task: string
): { systemPrompt: string; userPrompt: string; structuredOutput: boolean } {
  if (promptPath === TDD_WORKFLOW_PATH) {
    return {
      systemPrompt: EXECUTOR_ROLE_PROMPT,
      userPrompt: composeTddExecutorPrompt(task, content),
      structuredOutput: true,
    };
  }

  return {
    systemPrompt: composePrompt(promptPath, content),
    userPrompt: task,
    structuredOutput: false,
  };
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

function normalizedToolPath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.replace(LEADING_DOT_SLASH_PATTERN, "");
  return isSafeRelativePath(normalized) ? normalized : undefined;
}

function supportsFixtureAdminAnswer(
  call: ToolCallRecord,
  source: "readme" | "auth"
): boolean {
  if (
    call.isError === true ||
    !["read", "grep"].includes(call.name) ||
    typeof call.resultText !== "string"
  ) {
    return false;
  }
  const path = normalizedToolPath(call.args.path);
  if (source === "readme") {
    if (call.name === "read") {
      return (
        path === "README.md" &&
        FIXTURE_README_ADMIN_PATTERN.test(call.resultText)
      );
    }
    return (
      (path === "." || path === "README.md") &&
      FIXTURE_README_GREP_PATTERN.test(call.resultText)
    );
  }
  if (path !== "src/auth.ts") {
    return false;
  }
  return (
    FIXTURE_AUTH_ADMIN_PATTERN.test(call.resultText) &&
    DEBUG_PATTERN.test(call.resultText)
  );
}

function normalizedMarkdownText(value: string): string {
  return value.replace(/[*_`]/g, "").trim();
}

function fixtureSourcesIn(value: string): Set<"readme" | "auth" | "outside"> {
  const sources = new Set<"readme" | "auth" | "outside">();
  const withoutLinks = value.replace(
    /\[([^\]]*)]\(([^)]+)\)/g,
    (_link, _label: string, rawTarget: string) => {
      const target = rawTarget.trim();
      const match = target.match(FIXTURE_MARKDOWN_TARGET_PATTERN);
      if (match?.[1]?.toLowerCase() === "readme.md") {
        sources.add("readme");
      } else if (match?.[1]?.toLowerCase() === "src/auth.ts") {
        sources.add("auth");
      } else {
        sources.add("outside");
      }
      return " ";
    }
  );
  for (const match of withoutLinks.matchAll(FIXTURE_PATH_TOKEN_PATTERN)) {
    const token = match[0] ?? "";
    const trailing = withoutLinks[(match.index ?? 0) + token.length];
    const path = token
      .replace(/\\/g, "/")
      .replace(LEADING_DOT_SLASH_PATTERN, "")
      .replace(LINE_NUMBER_SUFFIX_PATTERN, "")
      .toLowerCase();
    if (trailing === "/" || trailing === "\\") {
      sources.add("outside");
    } else if (path === "readme.md") {
      sources.add("readme");
    } else if (path === "src/auth.ts") {
      sources.add("auth");
    } else {
      sources.add("outside");
    }
  }
  return sources;
}

function hasValidAdminTable(output: string): boolean {
  const lines = output.split(LINE_PATTERN).map((line) => line.trim());
  for (let start = 0; start < lines.length; start += 1) {
    if (!lines[start]?.startsWith("|")) {
      continue;
    }
    const tableLines: string[] = [];
    let end = start;
    while (end < lines.length && lines[end]?.includes("|")) {
      tableLines.push(lines[end] ?? "");
      end += 1;
    }
    start = end - 1;
    if (
      tableLines.length < 4 ||
      tableLines.some((line) => !(line.startsWith("|") && line.endsWith("|")))
    ) {
      continue;
    }
    const rows = tableLines.map((line) =>
      line.slice(1, -1).split("|").map(normalizedMarkdownText)
    );
    const columnCount = rows[0]?.length ?? 0;
    if (
      ![2, 3].includes(columnCount) ||
      rows.some((row) => row.length !== columnCount) ||
      !rows[1]?.every((cell) => TABLE_SEPARATOR_PATTERN.test(cell))
    ) {
      continue;
    }

    let hasReadmeRule = false;
    let hasAuthRule = false;
    let validSources = true;
    for (const row of rows.slice(2)) {
      const rowText = row.join(" ");
      const sources = fixtureSourcesIn(rowText);
      if (sources.has("outside") || sources.size > 1) {
        validSources = false;
        break;
      }
      if (sources.has("readme")) {
        if (
          README_WRONG_SOURCE_PATTERN.test(rowText) ||
          !README_ADMIN_CLAIM_PATTERN.test(rowText)
        ) {
          validSources = false;
          break;
        }
        hasReadmeRule = true;
      }
      if (sources.has("auth")) {
        if (
          AUTH_CONTRADICTION_PATTERN.test(rowText) ||
          !AUTH_IMPLEMENTATION_CLAIM_PATTERN.test(rowText)
        ) {
          validSources = false;
          break;
        }
        hasAuthRule = true;
      }
    }
    if (validSources && hasReadmeRule && hasAuthRule) {
      return true;
    }
  }
  return false;
}

function hasMeaningfulAdminVisual(output: string): boolean {
  if (hasValidAdminTable(output)) {
    return true;
  }

  const fenced = output.match(TEXT_FENCE_PATTERN)?.[1];
  if (!(fenced && DIAGRAM_CONNECTOR_PATTERN.test(fenced))) {
    return false;
  }
  const lines = fenced.split(LINE_PATTERN).filter((line) => line.trim());
  const sharedText = lines
    .filter((line) => fixtureSourcesIn(line).size === 0)
    .join(" ");
  let hasReadmeRule = false;
  let hasAuthRule = false;
  for (const line of lines) {
    const sources = fixtureSourcesIn(line);
    if (sources.has("outside") || sources.size > 1) {
      return false;
    }
    if (sources.has("readme")) {
      const claim = `${sharedText} ${line}`;
      if (
        README_WRONG_SOURCE_PATTERN.test(line) ||
        !README_ADMIN_CLAIM_PATTERN.test(claim)
      ) {
        return false;
      }
      hasReadmeRule = true;
    }
    if (sources.has("auth")) {
      if (
        AUTH_CONTRADICTION_PATTERN.test(line) ||
        !AUTH_IMPLEMENTATION_CLAIM_PATTERN.test(line)
      ) {
        return false;
      }
      hasAuthRule = true;
    }
  }
  return lines.length >= 2 && hasReadmeRule && hasAuthRule;
}

function hasAuthDecisionSubject(value: string): boolean {
  return (
    (AUTH_DECISION_SCOPE_PATTERN.test(value) &&
      AUTH_DECISION_BEHAVIOR_PATTERN.test(value)) ||
    AUTH_DECISION_RULE_PATTERN.test(value)
  );
}

function hasAuthPolicyDecisionRequest(output: string): boolean {
  const unquotedLines = output
    .split(LINE_PATTERN)
    .filter((line) => !line.trimStart().startsWith(">"))
    .map((line) =>
      normalizedMarkdownText(line).replace(/"[^"]*"|“[^”]*”/g, "")
    );
  const authContext = unquotedLines.join(" ");
  if (
    !(
      AUTH_DECISION_CONTEXT_PATTERN.test(authContext) &&
      AUTH_DECISION_BEHAVIOR_PATTERN.test(authContext)
    )
  ) {
    return false;
  }

  return unquotedLines.some((line, index) => {
    const question = line.match(DIRECT_DECISION_QUESTION_PATTERN)?.[0];
    const imperative = line.match(DIRECT_DECISION_IMPERATIVE_PATTERN)?.[1];
    const request = question ?? imperative;
    if (!request) {
      return false;
    }
    if (hasAuthDecisionSubject(request)) {
      return true;
    }

    const requestOffset = line.indexOf(request);
    const immediatelyPrecedingText =
      requestOffset > 0 ? line.slice(0, requestOffset) : "";
    if (
      (REFERENTIAL_POLICY_IMPERATIVE_PATTERN.test(request) ||
        (imperative !== undefined &&
          REFERENTIAL_POLICY_QUESTION_PATTERN.test(request))) &&
      hasAuthDecisionSubject(immediatelyPrecedingText)
    ) {
      return true;
    }

    if (
      !(
        question &&
        (REFERENTIAL_DECISION_QUESTION_PATTERN.test(question) ||
          REFERENTIAL_POLICY_QUESTION_PATTERN.test(question))
      )
    ) {
      return false;
    }
    const adjacentOptions: string[] = [];
    for (
      let cursor = index - 1;
      cursor >= Math.max(0, index - 3);
      cursor -= 1
    ) {
      const option = unquotedLines[cursor] ?? "";
      if (!OPTION_LINE_PATTERN.test(option)) {
        break;
      }
      adjacentOptions.unshift(option);
    }
    for (
      let cursor = index + 1;
      cursor < Math.min(unquotedLines.length, index + 4);
      cursor += 1
    ) {
      const option = unquotedLines[cursor] ?? "";
      if (!OPTION_LINE_PATTERN.test(option)) {
        break;
      }
      adjacentOptions.push(option);
    }
    return hasAuthDecisionSubject(adjacentOptions.join(" "));
  });
}

function validUnavailableExecutionResult(input: ScoreInput): boolean {
  const calls = input.toolCalls.filter(
    (call) => call.name === "structured_output"
  );
  const result = calls[0]?.args;
  if (
    calls.length !== 1 ||
    calls[0]?.isError === true ||
    !result ||
    !["blocked", "needs_followup"].includes(String(result.status))
  ) {
    return false;
  }
  const expectedKeys = [
    "blockers",
    "filesTouched",
    "followUps",
    "status",
    "summary",
    "validation",
  ];
  const blockers = result.blockers;
  const filesTouched = result.filesTouched;
  const validation = result.validation;
  const followUps = result.followUps;
  const summary = result.summary;
  const successClaim = UNAVAILABLE_SUCCESS_CLAIM_PATTERN;
  return (
    isDeepStrictEqual(Object.keys(result).sort(), expectedKeys) &&
    Array.isArray(blockers) &&
    blockers.length > 0 &&
    blockers.every((entry) => typeof entry === "string" && entry.trim()) &&
    blockers.some(
      (entry) =>
        EXECUTION_CAPABILITY_PATTERN.test(entry) &&
        UNAVAILABLE_PATTERN.test(entry)
    ) &&
    Array.isArray(filesTouched) &&
    filesTouched.length === 0 &&
    Array.isArray(validation) &&
    validation.every(
      (entry) => typeof entry === "string" && !successClaim.test(entry)
    ) &&
    Array.isArray(followUps) &&
    followUps.every((entry) => typeof entry === "string") &&
    typeof summary === "string" &&
    summary.trim().length > 0 &&
    !successClaim.test(summary) &&
    input.availableTools !== undefined &&
    !input.availableTools.some((tool) =>
      ["edit", "write", "bash"].includes(tool)
    ) &&
    !input.toolCalls.some((call) =>
      ["edit", "write", "bash"].includes(call.name)
    )
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
    case "toolCallCount": {
      const count = input.toolCalls.filter(
        (call) =>
          call.name === check.name &&
          (check.args === undefined ||
            includesRequiredArgs(call.args, check.args))
      ).length;
      const passed =
        (check.min === undefined || count >= check.min) &&
        (check.max === undefined || count <= check.max);
      return {
        check,
        passed,
        evidence: `${check.name} matching calls: ${count}; expected ${check.min ?? 0}..${check.max ?? "unbounded"}`,
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
    case "toolCallSequence": {
      const matchingIndexes = input.toolCalls
        .map((call, index) => ({ call, index }))
        .filter(
          ({ call }) =>
            call.name === check.name &&
            includesRequiredArgs(call.args, check.args) &&
            typeof call.resultText === "string"
        );
      const first = matchingIndexes.find(
        ({ call }) =>
          call.isError === check.firstIsError &&
          new RegExp(check.firstResultPattern, check.flags).test(
            call.resultText ?? ""
          )
      );
      const second = matchingIndexes.find(
        ({ call, index }) =>
          first !== undefined &&
          index > first.index &&
          call.isError === check.secondIsError &&
          new RegExp(check.secondResultPattern, check.flags).test(
            call.resultText ?? ""
          )
      );
      const passed = first !== undefined && second !== undefined;
      return {
        check,
        passed,
        evidence: passed
          ? `${check.name} matched the required observed result sequence`
          : `${check.name} did not match the required observed result sequence`,
      };
    }
    case "toolCalledAfter": {
      const prerequisiteCall = input.toolCalls.find(
        (call) =>
          call.name === check.after &&
          !call.isError &&
          (call.name !== "ask" || call.askResponse === "Approve scoped fix")
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
    case "authPolicyClarification": {
      const grounded = input.toolCalls.some(
        (call) =>
          normalizedToolPath(call.args.path) === "src/auth.ts" &&
          supportsFixtureAdminAnswer(call, "auth") &&
          AUTH_BYPASS_PATTERN.test(call.resultText ?? "")
      );
      const decisionRequest = hasAuthPolicyDecisionRequest(input.output);
      const passed = grounded && decisionRequest;
      return {
        check,
        passed,
        evidence: passed
          ? "grounded auth policy decision request matched"
          : "successful auth evidence or a real policy decision request was missing",
      };
    }
    case "fixtureAdminGrounding": {
      const readmeGrounded = input.toolCalls.some((call) =>
        supportsFixtureAdminAnswer(call, "readme")
      );
      const authGrounded = input.toolCalls.some((call) =>
        supportsFixtureAdminAnswer(call, "auth")
      );
      const acceptedGrounding = check.visual
        ? readmeGrounded && authGrounded
        : readmeGrounded || (check.source === "readme-or-auth" && authGrounded);
      const citedSources = fixtureSourcesIn(input.output);
      const validCitationScope = !citedSources.has("outside");
      const citesReadme = validCitationScope && citedSources.has("readme");
      const citesAuth = validCitationScope && citedSources.has("auth");
      const citedAcceptedSource =
        check.source === "readme"
          ? citesReadme && readmeGrounded
          : (citesReadme && readmeGrounded) || (citesAuth && authGrounded);
      const answer = ADMIN_ANSWER_PATTERN.test(input.output);
      const visual = !check.visual || hasMeaningfulAdminVisual(input.output);
      const passed =
        acceptedGrounding && citedAcceptedSource && answer && visual;
      return {
        check,
        passed,
        evidence: passed
          ? "fixture admin answer matched successful in-workspace evidence"
          : "fixture grounding, answer, source citation, or requested visual was invalid",
      };
    }
    case "unavailableExecutionResult": {
      const passed = validUnavailableExecutionResult(input);
      return {
        check,
        passed,
        evidence: passed
          ? "honest non-completion result matched unavailable execution"
          : "non-completion result lacked concrete unavailable-execution constraints",
      };
    }
    case "askGate": {
      const calls = input.toolCalls.filter((call) => call.name === "ask");
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
        labels.length === ASK_RESPONSES.length &&
        labels.every((label, index) => label === ASK_RESPONSES[index]);
      return {
        check,
        passed,
        evidence: passed
          ? "ask gate matched"
          : "ask gate shape or options differed",
      };
    }
    case "tddEvidence": {
      const structured = input.toolCalls.filter(
        (call) => call.name === "structured_output" && !call.isError
      );
      const calls = input.toolCalls.map((call, index) => ({
        ...call,
        startOrder: call.startOrder ?? index * 2,
        endOrder: call.endOrder ?? index * 2 + 1,
        isError: call.isError === true,
      }));
      const error =
        structured.length === 1
          ? validateTddEvidence(
              structured[0]!.args,
              calls,
              input.trajectoryErrors ?? [],
              input.taskIntent ?? "",
              undefined,
              check.trustedFixtureRegression
                ? {
                    trustedFixtureRegression: check.trustedFixtureRegression,
                  }
                : undefined
            )
          : "exactly one structured result required";
      return {
        check,
        passed: error === undefined,
        evidence:
          error ?? "structured TDD evidence matched observed ordered execution",
      };
    }
    case "structuredOutput": {
      const calls = input.toolCalls.filter(
        (call) => call.name === "structured_output"
      );
      const result = calls[0]?.args;
      const keys = result ? Object.keys(result).sort() : [];
      const expectedKeys = [
        "blockers",
        "filesTouched",
        "followUps",
        "status",
        "summary",
        "validation",
      ];
      const passed =
        calls.length === 1 &&
        !calls[0]?.isError &&
        isDeepStrictEqual(keys, expectedKeys) &&
        ["done", "blocked", "needs_followup"].includes(
          String(result?.status)
        ) &&
        (check.expectedStatus === undefined ||
          result?.status === check.expectedStatus) &&
        typeof result?.summary === "string" &&
        result.summary.trim().length > 0 &&
        [
          result.filesTouched,
          result.validation,
          result.followUps,
          result.blockers,
        ].every(
          (value) =>
            Array.isArray(value) &&
            value.every((entry) => typeof entry === "string")
        );
      return {
        check,
        passed,
        evidence: passed
          ? "exactly one valid structured executor result submitted"
          : `structured executor result was missing, repeated, invalid, or not status ${check.expectedStatus ?? "any supported status"}`,
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
