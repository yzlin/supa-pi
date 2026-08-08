import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import handoffExtension from "./handoff";
import sessionQueryExtension from "./session-query";

const model = { provider: "test", id: "model" };

function assistantResponse(text: string, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
  };
}

beforeAll(() => {
  initTheme("dark", false);
});

describe("Pi 0.84 runtime APIs", () => {
  it("hands off prose that mentions -model without treating it as an option", async () => {
    let commandHandler:
      | ((args: string, ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    const oldCalls: string[] = [];
    const replacementCalls: string[] = [];
    const completionCalls: unknown[][] = [];
    const replacementModel = { provider: "test", id: "replacement" };

    const pi = {
      on() {
        // Tool-path handlers are outside this regression.
      },
      registerTool() {
        // Tool path remains unchanged.
      },
      registerCommand(
        name: string,
        command: {
          handler: (
            args: string,
            ctx: Record<string, unknown>
          ) => Promise<void>;
        }
      ) {
        if (name === "handoff") {
          commandHandler = command.handler;
        }
      },
      sendUserMessage() {
        throw new Error("stale pi.sendUserMessage used after replacement");
      },
    } as unknown as ExtensionAPI;

    handoffExtension(pi);

    const modelRegistry = {
      complete(...args: unknown[]) {
        completionCalls.push(args);
        return assistantResponse("# Handoff\n\nContinue safely.");
      },
      find(provider: string, id: string) {
        return provider === "test" && id === "replacement"
          ? replacementModel
          : undefined;
      },
    };
    const replacementCtx = {
      hasUI: true,
      modelRegistry,
      sendUserMessage(prompt: string) {
        expect(prompt).toContain("**Handoff document:**");
        replacementCalls.push("sendUserMessage");
        return Promise.resolve();
      },
    };
    const ctx = {
      hasUI: true,
      model,
      modelRegistry,
      scopedModels: [{ model: replacementModel, thinkingLevel: "low" }],
      sessionManager: {
        getBranch() {
          return [
            {
              type: "message",
              message: { role: "user", content: "Old conversation" },
            },
          ];
        },
        getSessionFile() {
          return "/tmp/parent.jsonl";
        },
      },
      ui: {
        custom(render: (...args: unknown[]) => unknown) {
          return new Promise((resolve) => {
            let loader: { stop?: () => void } | undefined;
            const done = (value: unknown) => {
              loader?.stop?.();
              resolve(value);
            };
            loader = render(
              {
                requestRender() {
                  // Rendering is not observed by this regression.
                },
              },
              { fg: (_color: string, text: string) => text },
              undefined,
              done
            ) as { stop?: () => void };
          });
        },
        notify() {
          oldCalls.push("notify");
        },
      },
      async newSession(options: {
        parentSession?: string;
        withSession?: (ctx: typeof replacementCtx) => Promise<void>;
      }) {
        expect(options.parentSession).toBe("/tmp/parent.jsonl");
        expect(options.withSession).toBeFunction();
        await options.withSession?.(replacementCtx);
        return { cancelled: false };
      },
    };

    if (!commandHandler) {
      throw new Error("Expected handoff command");
    }
    await commandHandler("document why -model is not a command option", ctx);

    expect(completionCalls).toHaveLength(1);
    expect(completionCalls[0]?.[0]).toBe(model);
    expect(
      (completionCalls[0]?.[2] as { signal?: AbortSignal }).signal
    ).toBeInstanceOf(AbortSignal);
    expect(replacementCalls).toEqual(["sendUserMessage"]);
    expect(oldCalls).toEqual([]);
  });

  it("rejects an out-of-scope tool handoff before generating or storing it", async () => {
    let tool:
      | {
          execute: (...args: unknown[]) => Promise<{
            content: Array<{ type: string; text: string }>;
            details: unknown;
          }>;
        }
      | undefined;
    let completionCalls = 0;
    let customCalls = 0;
    const scopedModel = { provider: "test", id: "scoped" };

    handoffExtension({
      on() {
        // Deferred handlers must not receive a pending handoff.
      },
      registerCommand() {
        // Command path is outside this regression.
      },
      registerTool(registeredTool: typeof tool) {
        tool = registeredTool;
      },
    } as unknown as ExtensionAPI);

    if (!tool) {
      throw new Error("Expected handoff tool");
    }
    const result = await tool.execute(
      "call-1",
      { goal: "continue", model: "test/historical" },
      undefined,
      undefined,
      {
        hasUI: true,
        model,
        scopedModels: [{ model: scopedModel, thinkingLevel: "low" }],
        modelRegistry: {
          find() {
            return { provider: "test", id: "historical" };
          },
          complete() {
            completionCalls++;
            return assistantResponse("should not run");
          },
        },
        sessionManager: {
          getBranch() {
            return [
              { type: "message", message: { role: "user", content: "Old" } },
            ];
          },
        },
        ui: {
          custom() {
            customCalls++;
          },
        },
      }
    );

    expect(result.content[0]?.text).toBe(
      "Handoff: model test/historical is outside the current model scope"
    );
    expect(result.details).toEqual({ error: true });
    expect(completionCalls).toBe(0);
    expect(customCalls).toBe(0);
  });

  it("aborts deferred handoff when the requested model cannot be applied", async () => {
    let tool:
      | {
          execute: (...args: unknown[]) => Promise<{ content: unknown[] }>;
        }
      | undefined;
    let agentEnd:
      | ((event: unknown, ctx: Record<string, unknown>) => void)
      | undefined;
    let newSessionCalls = 0;
    let sendCalls = 0;
    const notifications: [string, string][] = [];
    const requestedModel = { provider: "test", id: "requested" };
    const pi = {
      on(
        event: string,
        handler: (event: unknown, ctx: Record<string, unknown>) => void
      ) {
        if (event === "agent_end") {
          agentEnd = handler;
        }
      },
      registerCommand() {
        // Command path is outside this regression.
      },
      registerTool(registeredTool: typeof tool) {
        tool = registeredTool;
      },
      setModel() {
        return Promise.resolve(false);
      },
      sendUserMessage() {
        sendCalls++;
      },
    } as unknown as ExtensionAPI;
    handoffExtension(pi);

    const ctx = {
      hasUI: true,
      model,
      scopedModels: [{ model: requestedModel, thinkingLevel: "low" }],
      modelRegistry: {
        find() {
          return requestedModel;
        },
        complete() {
          return assistantResponse("# Handoff\n\nContinue safely.");
        },
      },
      sessionManager: {
        getBranch() {
          return [
            { type: "message", message: { role: "user", content: "Old" } },
          ];
        },
        getSessionFile() {
          return "/tmp/parent.jsonl";
        },
        newSession() {
          newSessionCalls++;
        },
      },
      ui: {
        custom(render: (...args: unknown[]) => unknown) {
          return new Promise((resolve) => {
            render(
              {
                requestRender() {
                  // Rendering is not observed by this regression.
                },
              },
              { fg: (_color: string, text: string) => text },
              undefined,
              resolve
            );
          });
        },
        notify(message: string, level: string) {
          notifications.push([message, level]);
        },
      },
    };

    if (!(tool && agentEnd)) {
      throw new Error("Expected handoff tool and agent_end handler");
    }
    await tool.execute(
      "call-1",
      { goal: "continue", model: "test/requested" },
      undefined,
      undefined,
      ctx
    );
    agentEnd({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(newSessionCalls).toBe(0);
    expect(sendCalls).toBe(0);
    expect(notifications).toContainEqual([
      "Handoff aborted because the requested model could not be applied.",
      "error",
    ]);
  });

  it("rejects command model overrides before generating or replacing the session", async () => {
    let commandHandler:
      | ((args: string, ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    let completionCalls = 0;
    let newSessionCalls = 0;
    const notifications: [string, string][] = [];

    handoffExtension({
      on() {
        // Tool-path handlers are outside this regression.
      },
      registerTool() {
        // Tool path remains unchanged.
      },
      registerCommand(
        name: string,
        command: {
          handler: (
            args: string,
            ctx: Record<string, unknown>
          ) => Promise<void>;
        }
      ) {
        if (name === "handoff") {
          commandHandler = command.handler;
        }
      },
    } as unknown as ExtensionAPI);

    const ctx = {
      hasUI: true,
      model,
      modelRegistry: {
        complete() {
          completionCalls++;
          return assistantResponse("should not run");
        },
      },
      sessionManager: {
        getBranch() {
          return [
            { type: "message", message: { role: "user", content: "Old" } },
          ];
        },
        getSessionFile() {
          return "/tmp/parent.jsonl";
        },
      },
      ui: {
        notify(message: string, level: string) {
          notifications.push([message, level]);
        },
      },
      newSession() {
        newSessionCalls++;
        return Promise.resolve({ cancelled: false });
      },
    };

    if (!commandHandler) {
      throw new Error("Expected handoff command");
    }
    await commandHandler("-model test/replacement next task", ctx);

    expect(notifications).toEqual([
      ["/handoff does not support -model; use /handoff <goal>", "error"],
    ]);
    expect(completionCalls).toBe(0);
    expect(newSessionCalls).toBe(0);
  });

  it("keeps historical session models within the current model scope", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "session-query-scope-test-"));
    const sessionPath = join(cwd, "session.jsonl");
    writeFileSync(sessionPath, "fixture");
    const historicalModel = { provider: "test", id: "historical" };
    const scopedModel = { provider: "test", id: "scoped" };
    const openSpy = spyOn(SessionManager, "open").mockReturnValue({
      getBranch() {
        return [
          {
            type: "message",
            message: { role: "user", content: "Past decision" },
          },
          {
            type: "model_change",
            provider: historicalModel.provider,
            modelId: historicalModel.id,
          },
        ];
      },
    } as SessionManager);

    try {
      let tool:
        | {
            execute: (...args: unknown[]) => Promise<{
              content: Array<{ type: string; text: string }>;
            }>;
          }
        | undefined;
      sessionQueryExtension({
        registerTool(registeredTool: typeof tool) {
          tool = registeredTool;
        },
      } as unknown as ExtensionAPI);
      const completionModels: unknown[] = [];
      const ctx = {
        model: historicalModel,
        scopedModels: [{ model: scopedModel, thinkingLevel: "low" }],
        modelRegistry: {
          find() {
            return historicalModel;
          },
          complete(completionModel: unknown) {
            completionModels.push(completionModel);
            return assistantResponse("Scoped answer.");
          },
        },
      };

      if (!tool) {
        throw new Error("Expected session_query tool");
      }
      await tool.execute(
        "call-1",
        { sessionPath, question: "What was decided?" },
        new AbortController().signal,
        undefined,
        ctx
      );

      expect(completionModels).toEqual([scopedModel]);
    } finally {
      openSpy.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses modelRegistry.complete for session queries and forwards abort signal", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "session-query-test-"));
    const sessionPath = join(cwd, "session.jsonl");
    writeFileSync(sessionPath, "fixture");

    const openSpy = spyOn(SessionManager, "open").mockReturnValue({
      getBranch() {
        return [
          {
            type: "message",
            message: { role: "user", content: "Past decision" },
          },
        ];
      },
    } as SessionManager);

    try {
      let tool:
        | {
            execute: (...args: unknown[]) => Promise<{
              content: Array<{ type: string; text: string }>;
              details: unknown;
            }>;
          }
        | undefined;
      sessionQueryExtension({
        registerTool(registeredTool: typeof tool) {
          tool = registeredTool;
        },
      } as unknown as ExtensionAPI);

      const signal = new AbortController().signal;
      const completionCalls: unknown[][] = [];
      const ctx = {
        model,
        modelRegistry: {
          find() {
            return;
          },
          complete(...args: unknown[]) {
            completionCalls.push(args);
            return assistantResponse("Use the public runtime API.");
          },
        },
      };

      if (!tool) {
        throw new Error("Expected session_query tool");
      }
      const result = await tool.execute(
        "call-1",
        { sessionPath, question: "What was decided?" },
        signal,
        undefined,
        ctx
      );

      expect(completionCalls).toHaveLength(1);
      expect(completionCalls[0]?.[0]).toBe(model);
      expect(completionCalls[0]?.[2]).toEqual({ signal });
      expect(result.content[0]?.text).toContain("Use the public runtime API.");
    } finally {
      openSpy?.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
