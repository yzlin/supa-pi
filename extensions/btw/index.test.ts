import { describe, expect, it } from "bun:test";

import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import btwExtension from "./index";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

function successfulStream(model: Model<Api>) {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "pong" }],
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

describe("/btw", () => {
  it("streams through the model registry so extension-registered APIs resolve", async () => {
    // An api id that only an extension provider (pi.registerProvider) knows.
    const model = {
      id: "ext-model",
      name: "ext-model",
      api: "extension-only-stream-api",
      provider: "extension-provider",
    } as unknown as Model<Api>;

    let handler: CommandHandler | undefined;
    let resolveSent: (message: { details?: unknown }) => void = () => undefined;
    const sent = new Promise<{ details?: unknown }>((resolve) => {
      resolveSent = resolve;
    });
    const pi = {
      on: () => undefined,
      registerMessageRenderer: () => undefined,
      registerCommand: (name: string, options: { handler: CommandHandler }) => {
        if (name === "btw") {
          handler = options.handler;
        }
      },
      getThinkingLevel: () => "off",
      sendMessage: (message: { details?: unknown }) => resolveSent(message),
    } as unknown as ExtensionAPI;
    btwExtension(pi);

    const streamedModels: string[] = [];
    const ctx = {
      model,
      scopedModels: [],
      cwd: process.cwd(),
      getSystemPrompt: () => "system",
      isIdle: () => true,
      sessionManager: { getEntries: () => [], getLeafId: () => null },
      ui: { notify: () => undefined, setWidget: () => undefined },
      modelRegistry: {
        find: () => undefined,
        getApiKeyForProvider: () => Promise.resolve("test-key"),
        streamSimple: (selected: Model<Api>) => {
          streamedModels.push(selected.api);
          return successfulStream(selected);
        },
      },
    };

    await handler?.("say hi", ctx);
    const message = await sent;

    expect(streamedModels).toEqual(["extension-only-stream-api"]);
    expect(message.details).toMatchObject({
      task: "say hi",
      result: { exitCode: 0, finalOutput: "pong" },
    });
  });
});
