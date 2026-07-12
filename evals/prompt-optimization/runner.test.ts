import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { EvalCase } from "./index";
import { isContainedRelativePath, runVariant } from "./runner";

const fixturePath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/sample-project"
);
const modelRegistry = ModelRegistry.inMemory(AuthStorage.create());
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createMessage(
  model: Model<Api>,
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse" = "stop"
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 20,
      output: 8,
      reasoning: 2,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 33,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function createMessageStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  const reason = message.stopReason;
  if (reason !== "stop" && reason !== "toolUse") {
    throw new Error(`unsupported test stop reason: ${reason}`);
  }
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason, message });
  });
  return stream;
}

function createSuccessfulStream(model: Model<Api>) {
  return createMessageStream(
    createMessage(model, [
      {
        type: "text",
        text: "Evidence: src/math.ts uses subtraction.",
      },
    ])
  );
}

describe("workspace containment", () => {
  it("rejects POSIX and Windows traversal paths", () => {
    expect(isContainedRelativePath("../secret", "/")).toBe(false);
    expect(isContainedRelativePath("..\\secret", "\\")).toBe(false);
    expect(isContainedRelativePath("C:\\secret", "\\")).toBe(false);
    expect(isContainedRelativePath("src\\math.ts", "\\")).toBe(true);
  });
});

describe("runVariant", () => {
  it("runs a prompt in a fresh fixture and captures model telemetry", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    const evalCase: EvalCase = {
      id: "fake-run",
      workload: "explanation",
      promptPath: "extensions/core-prompt/prompt.md",
      task: "Explain the defect.",
      tools: [],
      checks: [
        {
          type: "outputIncludes",
          value: "src/math.ts",
          domain: "evidence",
          weight: 1,
        },
      ],
    };

    let observedSessionId: string | undefined;
    const result = await runVariant({
      evalCase,
      variant: "candidate",
      repetition: 1,
      promptContent: "Be evidence driven.",
      promptSha256: "candidate-hash",
      fixturePath,
      model,
      thinking: "medium",
      timeoutMs: 5000,
      maxTurns: 3,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel, _context, options) => {
        observedSessionId = options?.sessionId;
        return createSuccessfulStream(selectedModel);
      },
    });

    expect(result.completed).toBe(true);
    expect(result.sessionId).toBe(observedSessionId);
    expect(result.sessionId).toMatch(UUID_V7_PATTERN);
    expect(result.score.overall).toBe(1);
    expect(result.output).toContain("src/math.ts");
    expect(result.metrics).toMatchObject({
      inputTokens: 20,
      outputTokens: 8,
      reasoningTokens: 2,
      cacheReadTokens: 5,
      turns: 1,
    });
  });

  it("forwards and records priority service tier", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    let observedServiceTier: string | undefined;
    const result = await runVariant({
      evalCase: {
        id: "priority-run",
        workload: "explanation",
        promptPath: "extensions/core-prompt/prompt.md",
        task: "Explain the defect.",
        tools: [],
        checks: [
          {
            type: "outputIncludes",
            value: "src/math.ts",
            domain: "evidence",
            weight: 1,
          },
        ],
      },
      variant: "candidate",
      repetition: 1,
      promptContent: "Be evidence driven.",
      promptSha256: "candidate-hash",
      fixturePath,
      model,
      thinking: "medium",
      serviceTier: "priority",
      timeoutMs: 5000,
      maxTurns: 3,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel, _context, options) => {
        observedServiceTier = (options as { serviceTier?: string })
          ?.serviceTier;
        options?.onPayload?.({ service_tier: "priority" }, selectedModel);
        return createSuccessfulStream(selectedModel);
      },
    });

    expect(observedServiceTier).toBe("priority");
    expect(result.serviceTier).toBe("priority");
    expect(result.payloadServiceTier).toBe("priority");
  });

  it("executes fixture-bound tools and records the trajectory", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    let providerCall = 0;
    const result = await runVariant({
      evalCase: {
        id: "tool-run",
        workload: "exploration",
        promptPath: "agents/explorer.md",
        task: "Read src/math.ts and report the defect.",
        tools: ["read"],
        checks: [
          {
            type: "toolCalled",
            name: "read",
            domain: "task",
            weight: 1,
          },
        ],
      },
      variant: "baseline",
      repetition: 1,
      promptContent: "---\ndescription: Explore\n---\nRead carefully.",
      promptSha256: "baseline-hash",
      fixturePath,
      model,
      thinking: "low",
      timeoutMs: 5000,
      maxTurns: 3,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel) => {
        providerCall += 1;
        if (providerCall === 1) {
          return createMessageStream(
            createMessage(
              selectedModel,
              [
                {
                  type: "toolCall",
                  id: "read-1",
                  name: "read",
                  arguments: { path: "src/math.ts" },
                },
              ],
              "toolUse"
            )
          );
        }
        return createMessageStream(
          createMessage(selectedModel, [
            {
              type: "text",
              text: "src/math.ts subtracts right from left.",
            },
          ])
        );
      },
    });

    expect(result.completed).toBe(true);
    expect(result.toolCalls).toEqual([
      {
        name: "read",
        args: { path: "src/math.ts" },
        isError: false,
      },
    ]);
    expect(result.metrics).toMatchObject({ turns: 2, toolCalls: 1 });
  });

  it("blocks model file access outside the temporary workspace", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    let providerCall = 0;
    const result = await runVariant({
      evalCase: {
        id: "blocked-path",
        workload: "security",
        promptPath: "extensions/core-prompt/prompt.md",
        task: "Read a file.",
        tools: ["read"],
        checks: [
          {
            type: "outputIncludes",
            value: "blocked",
            domain: "quality",
            weight: 1,
          },
        ],
      },
      variant: "candidate",
      repetition: 1,
      promptContent: "Stay inside the workspace.",
      promptSha256: "candidate-hash",
      fixturePath,
      model,
      thinking: "low",
      timeoutMs: 5000,
      maxTurns: 3,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel) => {
        providerCall += 1;
        if (providerCall === 1) {
          return createMessageStream(
            createMessage(
              selectedModel,
              [
                {
                  type: "toolCall",
                  id: "read-outside",
                  name: "read",
                  arguments: { path: "/etc/passwd" },
                },
              ],
              "toolUse"
            )
          );
        }
        return createMessageStream(
          createMessage(selectedModel, [
            {
              type: "text",
              text: "The outside-workspace read was blocked.",
            },
          ])
        );
      },
    });

    expect(result.toolCalls[0]).toMatchObject({
      name: "read",
      args: { path: "/etc/passwd" },
      isError: true,
    });
    expect(result.metrics.toolErrors).toBe(1);
  });
});
