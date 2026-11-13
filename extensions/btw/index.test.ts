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
type EventHandler = (event: unknown, ctx: unknown) => unknown;

// An api id that only an extension provider (pi.registerProvider) knows.
const model = {
  id: "ext-model",
  name: "ext-model",
  api: "extension-only-stream-api",
  provider: "extension-provider",
} as unknown as Model<Api>;

function successfulStream(selected: Model<Api>, ready: Promise<void>) {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "pong" }],
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
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
  void ready.then(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
  });
  return stream;
}

/** Load the extension against a fake pi and command ctx. */
function setup(streamReady: Promise<void> = Promise.resolve()) {
  let command: CommandHandler | undefined;
  const handlers = new Map<string, EventHandler[]>();
  const sentMessages: Array<{ details?: unknown }> = [];
  let stale = false;
  const assertActive = () => {
    if (stale) {
      throw new Error("This extension ctx is stale");
    }
  };

  const pi = {
    on: (event: string, handler: EventHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerMessageRenderer: () => undefined,
    registerCommand: (name: string, options: { handler: CommandHandler }) => {
      if (name === "btw") {
        command = options.handler;
      }
    },
    getThinkingLevel: () => "off",
    sendMessage: (message: { details?: unknown }) => {
      assertActive();
      sentMessages.push(message);
    },
  } as unknown as ExtensionAPI;
  btwExtension(pi);

  const streamedApis: string[] = [];
  const ui = { notify: () => undefined, setWidget: () => undefined };
  const ctx = {
    model,
    scopedModels: [],
    cwd: process.cwd(),
    getSystemPrompt: () => "system",
    isIdle: () => true,
    sessionManager: { getEntries: () => [], getLeafId: () => null },
    get ui() {
      assertActive();
      return ui;
    },
    modelRegistry: {
      find: () => undefined,
      getApiKeyForProvider: () => Promise.resolve("test-key"),
      streamSimple: (selected: Model<Api>) => {
        streamedApis.push(selected.api);
        return successfulStream(selected, streamReady);
      },
    },
  };

  return {
    run: (args: string) => command?.(args, ctx),
    /** Emit session_shutdown, then make pi and ctx throw like a replaced session. */
    shutdown: async () => {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler({ type: "session_shutdown", reason: "quit" }, ctx);
      }
      stale = true;
    },
    sentMessages,
    streamedApis,
  };
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("/btw", () => {
  it("streams through the model registry so extension-registered APIs resolve", async () => {
    const harness = setup();

    await harness.run("say hi");
    await settle();

    expect(harness.streamedApis).toEqual(["extension-only-stream-api"]);
    expect(harness.sentMessages[0]?.details).toMatchObject({
      task: "say hi",
      result: { exitCode: 0, finalOutput: "pong" },
    });
  });

  it("does not touch the stale session after session_shutdown", async () => {
    let releaseStream: () => void = () => undefined;
    const harness = setup(
      new Promise<void>((resolve) => {
        releaseStream = resolve;
      }),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      await harness.run("say hi");
      await harness.shutdown();
      releaseStream();
      await settle();

      expect(unhandled).toEqual([]);
      expect(harness.sentMessages).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
