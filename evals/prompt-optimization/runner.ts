import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import type {
  AgentContext,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { agentLoop } from "@earendil-works/pi-agent-core";
import {
  closeOpenAICodexWebSocketSessions,
  stream,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
  convertToLlm,
  createCodingTools,
  createReadOnlyTools,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  type AssistantMessageRecord,
  composeEvalRequest,
  createEmptyMetrics,
  type EvalCase,
  type RunMetrics,
  reduceRunEvent,
  type ScoreResult,
  scoreRun,
  snapshotWorkspace,
  type ToolCallRecord,
} from "./index";

const LEADING_AT_PATTERN = /^@/;
const LEADING_WHITESPACE_PATTERN = /^\s*/;
const codexServiceTierStream: StreamFn = (model, context, options) => {
  const serviceTierOptions = options as typeof options & {
    serviceTier?: "priority";
  };
  return stream(model as never, context, {
    ...options,
    reasoningEffort: options?.reasoning,
    serviceTier: serviceTierOptions.serviceTier,
  } as never);
};

export type EvalVariant = "baseline" | "candidate";
export type EvalServiceTier = "default" | "priority";

export interface PlannedRun {
  caseId: string;
  repetition: number;
  variant: EvalVariant;
}

export function planRuns(
  caseIds: readonly string[],
  repetitions: number,
  singleArm = false,
): PlannedRun[] {
  const runs: PlannedRun[] = [];
  for (const [caseIndex, caseId] of caseIds.entries()) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      let variants: EvalVariant[];
      if (singleArm) {
        variants = ["candidate"];
      } else if ((caseIndex + repetition) % 2 === 0) {
        variants = ["baseline", "candidate"];
      } else {
        variants = ["candidate", "baseline"];
      }
      for (const variant of variants) {
        runs.push({ caseId, repetition, variant });
      }
    }
  }
  return runs;
}

export interface RunRecord {
  caseId: string;
  workload: string;
  promptPath: string;
  variant: EvalVariant;
  repetition: number;
  sessionId: string;
  model: string;
  responseModel?: string;
  thinking: ThinkingLevel;
  serviceTier: EvalServiceTier;
  payloadServiceTier?: string;
  promptSha256: string;
  output: string;
  stopReason?: string;
  error?: string;
  completed: boolean;
  taskPassed: boolean;
  testPassed: boolean | null;
  score: ScoreResult;
  metrics: RunMetrics;
  toolCalls: ToolCallRecord[];
  trajectoryErrors: string[];
  assistantMessages: AssistantMessageRecord[];
}

export interface RunVariantOptions {
  evalCase: EvalCase;
  variant: EvalVariant;
  repetition: number;
  promptContent: string;
  promptSha256: string;
  fixturePath: string;
  model: Model<Api>;
  thinking: ThinkingLevel;
  serviceTier?: EvalServiceTier;
  timeoutMs: number;
  maxTurns: number;
  getApiKey: (provider: string) => Promise<string | undefined>;
  streamFn?: StreamFn;
}

async function copyFixture(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source)) {
    await cp(join(source, entry), join(destination, entry), {
      recursive: true,
    });
  }
}

const IMMUTABLE_MATH_TEST = readFileSync(
  new URL("./fixtures/sample-project/tests/math.case.ts", import.meta.url),
  "utf8",
);
function stripComments(source: string): string | undefined {
  let output = "";
  let state: "code" | "line" | "block" = "code";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (state === "line") {
      if (character === "\n") {
        state = "code";
        output += character;
      } else {
        output += " ";
      }
    } else if (state === "block") {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else {
        output += character === "\n" ? "\n" : " ";
      }
    } else if (character === "/" && next === "/") {
      output += "  ";
      index += 1;
      state = "line";
    } else if (character === "/" && next === "*") {
      output += "  ";
      index += 1;
      state = "block";
    } else {
      output += character;
    }
  }
  return state === "block" ? undefined : output;
}

function stripHarmlessParentheses(source: string): string {
  let expression = source.trim();
  while (expression.startsWith("(") && expression.endsWith(")")) {
    let depth = 0;
    let wrapsExpression = true;
    for (let index = 0; index < expression.length; index += 1) {
      if (expression[index] === "(") {
        depth += 1;
      } else if (expression[index] === ")") {
        depth -= 1;
      }
      if (depth < 0 || (depth === 0 && index < expression.length - 1)) {
        wrapsExpression = false;
        break;
      }
    }
    if (!wrapsExpression || depth !== 0) {
      break;
    }
    expression = expression.slice(1, -1).trim();
  }
  return expression;
}

function expressionMatchesOperation(
  source: string,
  leftParameter: string,
  rightParameter: string,
  operator: string,
): boolean {
  const expression = stripHarmlessParentheses(source);
  let depth = 0;
  let operatorIndex = -1;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    } else if (character === operator && depth === 0) {
      if (operatorIndex !== -1) {
        return false;
      }
      operatorIndex = index;
    }
    if (depth < 0) {
      return false;
    }
  }
  return (
    depth === 0 &&
    operatorIndex !== -1 &&
    stripHarmlessParentheses(expression.slice(0, operatorIndex)) ===
      leftParameter &&
    stripHarmlessParentheses(expression.slice(operatorIndex + 1)) ===
      rightParameter
  );
}

/** Scores allowlisted fixture tests with a bounded closed arithmetic grammar; never executes workspace code. */
export function runAllowedFixtureTest(
  cwd: string,
  command = "bun test tests/math.case.ts",
): { exitCode: number; output: Buffer } {
  const specifications = {
    "bun test tests/math.case.ts": {
      tests: [{ path: "tests/math.case.ts", content: IMMUTABLE_MATH_TEST }],
      operations: { add: "+", multiply: "*" },
      success:
        "tests/math.case.ts > math > adds numbers\ntests/math.case.ts > math > multiplies numbers\n2 passed, 0 failed\n",
      failure:
        "tests/math.case.ts > math > adds numbers\nExpected: 12\nReceived: 2\n1 failed, 1 passed\n",
    },
  } as const;
  const specification = specifications[command as keyof typeof specifications];
  if (!specification) {
    return {
      exitCode: 126,
      output: Buffer.from("Blocked by eval command allowlist\n"),
    };
  }
  try {
    for (const test of specification.tests) {
      let actual: string;
      try {
        actual = readFileSync(join(cwd, test.path), "utf8");
      } catch {
        return {
          exitCode: 1,
          output: Buffer.from(
            `${test.path}: required canonical test is missing\n1 failed, 0 passed\n`,
          ),
        };
      }
      if (actual !== test.content) {
        return {
          exitCode: 1,
          output: Buffer.from(
            `${test.path}: required canonical test was modified\n1 failed, 0 passed\n`,
          ),
        };
      }
    }
    const source = stripComments(
      readFileSync(join(cwd, "src/math.ts"), "utf8"),
    );
    const declaration =
      /export\s+function\s+(add|multiply)\s*\(\s*([A-Za-z_$][\w$]*)\s*:\s*number\s*,\s*([A-Za-z_$][\w$]*)\s*:\s*number\s*\)\s*:\s*number\s*\{\s*return\s+([^;{}\n]{1,200});\s*\}/gy;
    const operations = new Map<
      string,
      { leftParameter: string; rightParameter: string; expression: string }
    >();
    let offset = 0;
    while (source !== undefined) {
      declaration.lastIndex = offset;
      const whitespace =
        LEADING_WHITESPACE_PATTERN.exec(source.slice(offset))?.[0].length ?? 0;
      declaration.lastIndex += whitespace;
      const match = declaration.exec(source);
      if (
        !match ||
        match.index !== offset + whitespace ||
        operations.has(match[1]!)
      ) {
        break;
      }
      operations.set(match[1]!, {
        leftParameter: match[2]!,
        rightParameter: match[3]!,
        expression: match[4]!,
      });
      offset = declaration.lastIndex;
    }
    const fullyParsed =
      source !== undefined && source.slice(offset).trim() === "";
    const expected = Object.entries(specification.operations);
    const supportedOperators = ["+", "*"];
    const hasOnlyClosedExpressions = [...operations.values()].every(
      (implementation) =>
        supportedOperators.some((operator) =>
          expressionMatchesOperation(
            implementation.expression,
            implementation.leftParameter,
            implementation.rightParameter,
            operator,
          ),
        ),
    );
    const passed =
      fullyParsed &&
      hasOnlyClosedExpressions &&
      expected.every(([name, operator]) => {
        const implementation = operations.get(name);
        return (
          implementation !== undefined &&
          expressionMatchesOperation(
            implementation.expression,
            implementation.leftParameter,
            implementation.rightParameter,
            operator,
          )
        );
      });
    return {
      exitCode: passed ? 0 : 1,
      output: Buffer.from(
        passed ? specification.success : specification.failure,
      ),
    };
  } catch {
    return {
      exitCode: 1,
      output: Buffer.from("1 failed: fixture files unavailable\n"),
    };
  }
}

const ALLOWED_FIXTURE_TEST_COMMANDS = new Set(["bun test tests/math.case.ts"]);

export function isAllowedFixtureTestCommand(command: string): boolean {
  return ALLOWED_FIXTURE_TEST_COMMANDS.has(
    command.trim().replaceAll(/\s+/g, " "),
  );
}

function createSafeBashOperations() {
  return {
    async exec(
      command: string,
      cwd: string,
      options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
      },
    ): Promise<{ exitCode: number | null }> {
      const normalized = command.trim().replaceAll(/\s+/g, " ");
      if (!isAllowedFixtureTestCommand(command)) {
        options.onData(
          Buffer.from(`Blocked by eval command allowlist: ${command}\n`),
        );
        return { exitCode: 126 };
      }

      if (options.signal?.aborted) {
        return { exitCode: null };
      }
      const execution = await Promise.resolve(
        runAllowedFixtureTest(cwd, normalized),
      );
      if (execution.output.length) {
        options.onData(execution.output);
      }
      return { exitCode: execution.exitCode };
    },
  };
}

const agentToolSchema = Type.Object({
  prompt: Type.String(),
  description: Type.Optional(Type.String()),
  subagent_type: Type.Optional(Type.String()),
});

const agentTool: AgentTool<typeof agentToolSchema> = {
  name: "Agent",
  label: "Agent",
  description:
    "Delegate one bounded analysis task to a deterministic eval worker.",
  parameters: agentToolSchema,
  execute(_toolCallId, params) {
    return Promise.resolve({
      content: [
        {
          type: "text" as const,
          text: `Worker result for ${params.subagent_type ?? "general"}: src/math.ts returns subtraction instead of addition; verify with bun test tests/math.case.ts.`,
        },
      ],
      details: {},
    });
  },
};

const webSearchTool: AgentTool = {
  name: "web_search",
  label: "Web search",
  description: "Search the fixed offline eval source corpus.",
  parameters: Type.Object({ query: Type.String() }),
  execute() {
    return Promise.resolve({
      content: [
        {
          type: "text" as const,
          text: "Result: docs/options.md — Option A keeps validation local; Option B centralizes it and adds migration cost.",
        },
      ],
      details: {},
    });
  },
};

const askSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      id: Type.String(),
      label: Type.Optional(Type.String()),
      prompt: Type.String(),
      options: Type.Array(
        Type.Object({
          value: Type.String(),
          label: Type.String(),
          description: Type.Optional(Type.String()),
        }),
      ),
      multiSelect: Type.Optional(Type.Boolean()),
    }),
  ),
});

function createAskTool(
  response: NonNullable<EvalCase["askResponse"]>,
): AgentTool<typeof askSchema> {
  return {
    name: "ask",
    label: "Ask",
    description:
      "Ask the user structured questions. This eval supplies a deterministic user selection.",
    parameters: askSchema,
    execute(_toolCallId, params) {
      const question = params.questions[0];
      const option = question?.options.find(
        (candidate) => candidate.label === response,
      );
      if (!(question && option)) {
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: "Ask rejected: required supplied option missing.",
            },
          ],
          details: { cancelled: true },
          isError: true,
        });
      }
      return Promise.resolve({
        content: [
          {
            type: "text" as const,
            text: `${question.label ?? question.id}: ${option.label}`,
          },
        ],
        details: {
          cancelled: false,
          answers: [
            {
              kind: "option",
              id: question.id,
              value: option.value,
              label: option.label,
              wasCustom: false,
              index: question.options.indexOf(option) + 1,
            },
          ],
          answersByQuestion: { [question.id]: option.value },
        },
      });
    },
  };
}

const fetchContentTool: AgentTool = {
  name: "fetch_content",
  label: "Fetch content",
  description: "Read one result from the fixed offline eval source corpus.",
  parameters: Type.Object({ url: Type.String() }),
  execute() {
    return Promise.resolve({
      content: [
        {
          type: "text" as const,
          text: "docs/options.md: Option A is simpler for one consumer. Option B is preferred only when three or more consumers need shared validation.",
        },
      ],
      details: {},
    });
  },
};

export function isContainedRelativePath(
  relativePath: string,
  pathSeparator = sep,
): boolean {
  const absolute =
    pathSeparator === "\\"
      ? win32.isAbsolute(relativePath)
      : isAbsolute(relativePath);
  return (
    relativePath === "" ||
    (!absolute &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${pathSeparator}`))
  );
}

function isWithinDirectory(directory: string, target: string): boolean {
  return isContainedRelativePath(relative(directory, target));
}

async function isSafeWorkspacePath(
  workspace: string,
  requestedPath: string,
): Promise<boolean> {
  const workspacePath = await realpath(workspace);
  const targetPath = resolve(
    workspacePath,
    requestedPath.replace(LEADING_AT_PATTERN, ""),
  );
  if (!isWithinDirectory(workspacePath, targetPath)) {
    return false;
  }

  let existingAncestor = targetPath;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      return false;
    }
    existingAncestor = parent;
  }
  return isWithinDirectory(workspacePath, await realpath(existingAncestor));
}

function createTools(workspace: string, evalCase: EvalCase): AgentTool[] {
  const names = evalCase.tools;
  const builtInsByName = new Map(
    [
      ...createCodingTools(workspace, {
        bash: { operations: createSafeBashOperations() },
      }),
      ...createReadOnlyTools(workspace),
    ].map((tool) => [tool.name, tool]),
  );
  const builtIns = [...builtInsByName.values()].filter((tool) =>
    names.includes(tool.name as EvalCase["tools"][number]),
  );
  const extras = [agentTool, webSearchTool, fetchContentTool].filter((tool) =>
    names.includes(tool.name as EvalCase["tools"][number]),
  );
  const askTools = evalCase.askResponse
    ? [createAskTool(evalCase.askResponse)]
    : [];
  return [...builtIns, ...extras, ...askTools];
}

function textFromContent(
  content: Array<{ type?: string; text?: string }> | undefined,
): string {
  return (content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export async function runVariant(
  options: RunVariantOptions,
): Promise<RunRecord> {
  const workspace = await mkdtemp(join(tmpdir(), "supa-pi-prompt-eval-"));
  const sessionId = SessionManager.inMemory().getSessionId();
  await copyFixture(options.fixturePath, workspace);
  const initialWorkspaceSnapshot = await snapshotWorkspace(workspace);
  const tools = createTools(workspace, options.evalCase);
  const request = composeEvalRequest(
    options.evalCase.promptPath,
    options.promptContent,
    options.evalCase.task,
  );
  const context: AgentContext = {
    messages: [
      {
        role: "system",
        content: [
          request.systemPrompt,
          "# Eval environment",
          `Working directory: ${workspace}`,
          "Fixture restriction: `tests/math.case.ts` must remain byte-for-byte unchanged. Do not edit, replace, or add assertions to this file.",
        ].join("\n\n"),
        timestamp: Date.now(),
      },
    ],
    tools,
  };
  const prompt: AgentMessage = {
    role: "user",
    content: request.userPrompt,
    timestamp: Date.now(),
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const startedAt = performance.now();
  let metrics = createEmptyMetrics();
  let output = "";
  let stopReason: string | undefined;
  let error: string | undefined;
  let responseModel: string | undefined;
  let observedTurns = 0;
  const toolCalls: ToolCallRecord[] = [];
  const trajectoryErrors: string[] = [];
  const recordTrajectoryError = (message: string) => {
    if (trajectoryErrors.length < 20) {
      trajectoryErrors.push(message);
    }
  };
  const assistantMessages: AssistantMessageRecord[] = [];
  const pendingToolCalls = new Map<string, ToolCallRecord>();
  let eventOrder = 0;
  const serviceTier = options.serviceTier ?? "default";
  const payloadServiceTiers = new Set<string>();

  try {
    const eventStream = agentLoop(
      [prompt],
      context,
      {
        model: options.model,
        reasoning: options.thinking === "off" ? undefined : options.thinking,
        sessionId,
        transport: "auto",
        ...(serviceTier === "priority" ? { serviceTier: "priority" } : {}),
        onPayload(payload) {
          const candidate = payload as Record<string, unknown> | null;
          payloadServiceTiers.add(
            typeof candidate?.service_tier === "string"
              ? candidate.service_tier
              : "absent",
          );
        },
        convertToLlm: (messages) => convertToLlm(messages),
        getApiKey: options.getApiKey,
        beforeToolCall: async ({ toolCall, args }) => {
          if (
            ["read", "write", "edit", "grep", "find", "ls"].includes(
              toolCall.name,
            )
          ) {
            const requestedPath = (args as { path?: unknown }).path;
            if (
              typeof requestedPath === "string" &&
              !(await isSafeWorkspacePath(workspace, requestedPath))
            ) {
              return {
                block: true,
                reason: `Eval tools cannot access paths outside the workspace: ${requestedPath}`,
              };
            }
          }
          return;
        },
        shouldStopAfterTurn: () => observedTurns >= options.maxTurns,
      } as AgentLoopConfig & { serviceTier?: "priority" },
      controller.signal,
      options.streamFn ??
        (options.serviceTier ? codexServiceTierStream : undefined),
    );

    for await (const event of eventStream) {
      eventOrder += 1;
      if (event.type === "tool_execution_start") {
        if (pendingToolCalls.has(event.toolCallId)) {
          recordTrajectoryError(`duplicate start: ${event.toolCallId}`);
          continue;
        }
        if (pendingToolCalls.size >= 100) {
          recordTrajectoryError("pending tool-call capture limit exceeded");
          continue;
        }
        const rawArgs =
          event.args && typeof event.args === "object"
            ? (event.args as Record<string, unknown>)
            : {};
        const call: ToolCallRecord = {
          name: event.toolName,
          args: rawArgs,
          assistantTurn: observedTurns,
          startOrder: eventOrder,
        };
        pendingToolCalls.set(event.toolCallId, call);
      }
      if (event.type === "tool_execution_end") {
        const pending = pendingToolCalls.get(event.toolCallId);
        if (!pending) {
          recordTrajectoryError(`unmatched end: ${event.toolCallId}`);
        }
        const call = pending ?? {
          name: event.toolName,
          args: {},
          assistantTurn: observedTurns,
          startOrder: eventOrder,
        };
        const askResponse =
          call.name === "ask"
            ? (event.result?.details?.answers?.[0]?.label as unknown)
            : undefined;
        const resultText = textFromContent(event.result?.content);
        const completedCall: ToolCallRecord = {
          ...call,
          endOrder: eventOrder,
          isError: event.isError,
          ...(resultText ? { resultText } : {}),
          ...(typeof askResponse === "string" ? { askResponse } : {}),
        };
        toolCalls.push(completedCall);
        pendingToolCalls.delete(event.toolCallId);
        metrics = reduceRunEvent(metrics, {
          ...event,
          args: call.args,
        } as unknown as Record<string, unknown>);
      } else {
        metrics = reduceRunEvent(
          metrics,
          event as unknown as Record<string, unknown>,
        );
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        observedTurns += 1;
        const text = textFromContent(event.message.content);
        if (text) {
          output = text;
          assistantMessages.push({ text, assistantTurn: observedTurns });
        }
        stopReason = event.message.stopReason;
        error = event.message.errorMessage;
        responseModel = event.message.responseModel ?? event.message.model;
      }
    }
  } catch (runError) {
    error = runError instanceof Error ? runError.message : String(runError);
  } finally {
    clearTimeout(timeout);
    metrics.latencyMs = Math.round(performance.now() - startedAt);
    closeOpenAICodexWebSocketSessions(sessionId);
  }

  if (pendingToolCalls.size > 0) {
    const pendingIds = [...pendingToolCalls.keys()].slice(0, 5).join(", ");
    recordTrajectoryError(
      `pending starts at terminal status: ${pendingToolCalls.size}${pendingIds ? ` (${pendingIds})` : ""}`,
    );
  }

  const { failedToolKeys: _failedToolKeys, ...publicMetrics } =
    metrics as RunMetrics & {
      failedToolKeys?: string[];
    };
  try {
    const score = await scoreRun(
      {
        output,
        workspace,
        initialWorkspaceSnapshot,
        toolCalls,
        assistantMessages,
        trajectoryErrors,
        taskIntent: options.evalCase.task,
      },
      options.evalCase.checks,
    );
    const completed =
      !error && stopReason !== "error" && stopReason !== "aborted";
    const taskDomains = [
      score.domains.task,
      score.domains.evidence,
      score.domains.quality,
    ].filter((value): value is number => value !== null);
    const testScore = score.domains.tests;
    let payloadServiceTier: string | undefined;
    if (payloadServiceTiers.size === 1) {
      [payloadServiceTier] = payloadServiceTiers;
    } else if (payloadServiceTiers.size > 1) {
      payloadServiceTier = "mixed";
    }
    return {
      caseId: options.evalCase.id,
      workload: options.evalCase.workload,
      promptPath: options.evalCase.promptPath,
      variant: options.variant,
      repetition: options.repetition,
      sessionId,
      model: `${options.model.provider}/${options.model.id}`,
      responseModel,
      thinking: options.thinking,
      serviceTier,
      payloadServiceTier,
      promptSha256: options.promptSha256,
      output,
      stopReason,
      error,
      completed,
      taskPassed:
        completed &&
        taskDomains.length > 0 &&
        taskDomains.every((domainScore) => domainScore === 1),
      testPassed: testScore === null ? null : testScore === 1,
      score,
      metrics: publicMetrics,
      toolCalls,
      trajectoryErrors,
      assistantMessages,
    };
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}
