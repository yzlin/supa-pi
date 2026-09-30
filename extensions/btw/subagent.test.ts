import { describe, expect, it } from "bun:test";

import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai/compat";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  appendFinalOutput,
  renderProgressPlainLines,
  resolveExitCode,
  runSubagent,
} from "./subagent";

const modelRegistry = new ModelRegistry(await ModelRuntime.create());

function successfulStream(model: Model<Api>) {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
  });
  return stream;
}

describe("runSubagent", () => {
  it("sends inherited instructions as the leading provider transcript message", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }

    let providerMessages: Array<{ role: string; content: unknown }> = [];
    const result = await runSubagent(
      "Inherited parent instructions",
      "Inspect the repository",
      [],
      model,
      "off",
      () => Promise.resolve("test-key"),
      undefined,
      () => undefined,
      (selectedModel, context) => {
        providerMessages = context.messages;
        return successfulStream(selectedModel);
      },
    );

    expect(providerMessages.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
    expect(providerMessages[0]?.content).toBe("Inherited parent instructions");
    expect(result.finalOutput).toBe("done");
  });
});

describe("renderProgressPlainLines", () => {
  it("serializes structured path arguments without object placeholders", () => {
    const lines = renderProgressPlainLines("Inspect files", {
      task: "Inspect files",
      exitCode: 0,
      finalOutput: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      displayItems: ["read", "write", "edit"].map((name) => ({
        type: "toolCall" as const,
        name,
        args: { path: { file: "src/main.ts" } },
      })),
    });
    expect(lines.slice(1)).toEqual([
      '  read {"file":"src/main.ts"}',
      '  write {"file":"src/main.ts"}',
      '  edit {"file":"src/main.ts"}',
    ]);
  });
});

describe("appendFinalOutput", () => {
  it("keeps the first text chunk unchanged", () => {
    expect(appendFinalOutput("", "first chunk")).toBe("first chunk");
  });

  it("appends later text chunks with newlines", () => {
    expect(appendFinalOutput("first chunk", "second chunk")).toBe(
      "first chunk\nsecond chunk",
    );
  });
});

describe("resolveExitCode", () => {
  it("returns success for completed runs", () => {
    expect(resolveExitCode(undefined, false)).toBe(0);
  });

  it("returns failure for explicit error stop reasons", () => {
    expect(resolveExitCode("error", false)).toBe(1);
  });

  it("returns failure for aborted stop reasons", () => {
    expect(resolveExitCode("aborted", false)).toBe(1);
  });

  it("returns failure for aborted signals even without a stop reason", () => {
    expect(resolveExitCode(undefined, true)).toBe(1);
  });
});
