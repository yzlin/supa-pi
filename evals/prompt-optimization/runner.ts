import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
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
  composePrompt,
  createEmptyMetrics,
  type EvalCase,
  type RunMetrics,
  reduceRunEvent,
  type ScoreResult,
  scoreRun,
  type ToolCallRecord,
} from "./index";

const LEADING_AT_PATTERN = /^@/;

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

function createSafeBashOperations() {
  return {
    async exec(
      command: string,
      cwd: string,
      options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
      }
    ): Promise<{ exitCode: number | null }> {
      const normalized = command.trim().replaceAll(/\s+/g, " ");
      if (normalized !== "bun test tests/math.case.ts") {
        options.onData(
          Buffer.from(`Blocked by eval command allowlist: ${command}\n`)
        );
        return { exitCode: 126 };
      }

      if (options.signal?.aborted) {
        return { exitCode: null };
      }
      const mathSource = await readFile(join(cwd, "src/math.ts"), "utf8");
      const passed = mathSource.includes("return left + right;");
      options.onData(
        Buffer.from(
          passed
            ? "1 pass\n0 fail\n"
            : "0 pass\n1 fail\nExpected add(7, 5) to be 12\n"
        )
      );
      return { exitCode: passed ? 0 : 1 };
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
  pathSeparator = sep
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
  requestedPath: string
): Promise<boolean> {
  const workspacePath = await realpath(workspace);
  const targetPath = resolve(
    workspacePath,
    requestedPath.replace(LEADING_AT_PATTERN, "")
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

function createTools(workspace: string, names: EvalCase["tools"]): AgentTool[] {
  const builtInsByName = new Map(
    [
      ...createCodingTools(workspace, {
        bash: { operations: createSafeBashOperations() },
      }),
      ...createReadOnlyTools(workspace),
    ].map((tool) => [tool.name, tool])
  );
  const builtIns = [...builtInsByName.values()].filter((tool) =>
    names.includes(tool.name as EvalCase["tools"][number])
  );
  const extras = [agentTool, webSearchTool, fetchContentTool].filter((tool) =>
    names.includes(tool.name as EvalCase["tools"][number])
  );
  return [...builtIns, ...extras];
}

function textFromAssistantMessage(message: {
  content?: Array<{ type?: string; text?: string }>;
}): string {
  return (message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export async function runVariant(
  options: RunVariantOptions
): Promise<RunRecord> {
  const workspace = await mkdtemp(join(tmpdir(), "supa-pi-prompt-eval-"));
  const sessionId = SessionManager.inMemory().getSessionId();
  await copyFixture(options.fixturePath, workspace);
  const tools = createTools(workspace, options.evalCase.tools);
  const context: AgentContext = {
    systemPrompt: [
      composePrompt(options.evalCase.promptPath, options.promptContent),
      "# Eval environment",
      `Working directory: ${workspace}`,
    ].join("\n\n"),
    messages: [],
    tools,
  };
  const prompt: AgentMessage = {
    role: "user",
    content: options.evalCase.task,
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
  const pendingToolCalls = new Map<string, ToolCallRecord>();
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
              : "absent"
          );
        },
        convertToLlm: (messages) => convertToLlm(messages),
        getApiKey: options.getApiKey,
        beforeToolCall: async ({ toolCall, args }) => {
          if (
            ["read", "write", "edit", "grep", "find", "ls"].includes(
              toolCall.name
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
        (options.serviceTier ? codexServiceTierStream : undefined)
    );

    for await (const event of eventStream) {
      if (event.type === "tool_execution_start") {
        const call = { name: event.toolName, args: event.args };
        pendingToolCalls.set(event.toolCallId, call);
      }
      if (event.type === "tool_execution_end") {
        const call = pendingToolCalls.get(event.toolCallId) ?? {
          name: event.toolName,
          args: {},
        };
        const completedCall = { ...call, isError: event.isError };
        toolCalls.push(completedCall);
        pendingToolCalls.delete(event.toolCallId);
        metrics = reduceRunEvent(metrics, {
          ...event,
          args: call.args,
        } as unknown as Record<string, unknown>);
      } else {
        metrics = reduceRunEvent(
          metrics,
          event as unknown as Record<string, unknown>
        );
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        observedTurns += 1;
        const text = textFromAssistantMessage(event.message);
        if (text) {
          output = text;
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

  const { failedToolKeys: _failedToolKeys, ...publicMetrics } =
    metrics as RunMetrics & {
      failedToolKeys?: string[];
    };
  try {
    const score = await scoreRun(
      { output, workspace, toolCalls },
      options.evalCase.checks
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
    };
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}
