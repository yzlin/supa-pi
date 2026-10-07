import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionToolContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { registerExecutionLedger } from "./runtime";
import {
  type Checkpoint,
  CheckpointOutputSchema,
  type WorkerReport,
  WorkerReportSchema,
} from "./schema";

const report: WorkerReport = {
  status: "done",
  summary: "Offline fixture finished",
  filesTouched: [],
  validation: ["Fixture only"],
  followUps: [],
  blockers: [],
};
const done = () => ({
  content: [{ type: "text" as const, text: "Fixture complete" }],
  details: {},
});

function latch() {
  let resolve = () => {};
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

// Real public SDK lifecycle/pipeline, no tmux/model/network/config dependencies.
async function nativeHarness(
  configure: (pi: ExtensionAPI) => void = () => {},
  waitForAbort = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), "execute-lifecycle-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  const provider = fauxProvider({ tokensPerSecond: 100_000 });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const sessionManager = SessionManager.inMemory(cwd);
  let script: (ctx: ExtensionToolContext) => Promise<void> = async () => {};
  let failure: unknown;
  let authorize: ReturnType<typeof registerExecutionLedger> | undefined;
  let childCount = 0;
  const childStarted = latch();
  const boundaries: string[] = [];
  const signals: AbortSignal[] = [];
  const hookErrors: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        authorize = registerExecutionLedger(pi);
        pi.on("agent_start", (_event, ctx) => {
          if (ctx.signal) {
            signals.push(ctx.signal);
          }
        });
        pi.on("agent_before_settle", () => {
          boundaries.push("before_settle");
        });
        pi.on("agent_settled", () => {
          boundaries.push("settled");
        });
        pi.registerTool({
          name: "fixture",
          label: "Fixture",
          description: "Native test bridge",
          parameters: Type.Object({}),
          async execute(_id, _args, _signal, _update, ctx) {
            try {
              await script(ctx);
            } catch (error) {
              failure = error;
            }
            return done();
          },
        });
        pi.registerTool({
          name: "subagent",
          label: "Child fixture",
          description: "No real child can start in a blocked dispatch",
          parameters: Type.Object({
            agent: Type.String(),
            task: Type.String(),
            schema: Type.Unknown(),
          }),
          async execute(_id, _args, signal) {
            childCount++;
            childStarted.resolve();
            if (waitForAbort) {
              await new Promise<void>((resolve) => {
                if (signal?.aborted) {
                  resolve();
                } else {
                  signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                }
              });
            }
            return {
              ...done(),
              structuredContent: {
                runId: "fixture-run",
                structuredOutput: report,
              },
            };
          },
        });
        configure(pi); // Deliberately later than the ledger's binding hook.
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: provider.getModel(),
    modelRuntime,
    settingsManager,
    sessionManager,
    resourceLoader: loader,
  });
  await session.bindExtensions({
    mode: "print",
    onError: (error) => hookErrors.push(error.error),
  });
  async function run(fn: typeof script) {
    script = fn;
    failure = undefined;
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("fixture", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Normal settlement"),
    ]);
    await session.prompt("Run offline fixture");
    if (failure) {
      throw failure;
    }
    expect(hookErrors).toEqual([]);
  }
  return {
    session,
    provider,
    boundaries,
    signals,
    childStarted,
    childCount: () => childCount,
    run,
    authorize: (ctx: ExtensionToolContext) => {
      if (!authorize) {
        throw new Error("Missing ledger authorization owner");
      }
      return authorize(ctx);
    },
    dispose: () => {
      session.dispose();
      if (previousOffline === undefined) {
        delete process.env.PI_OFFLINE;
      } else {
        process.env.PI_OFFLINE = previousOffline;
      }
    },
  };
}

async function checkpoint(ctx: ExtensionToolContext, input: Checkpoint) {
  const outcome = await ctx.executeTool("execute_checkpoint", input);
  if (outcome.isError) {
    throw new Error(JSON.stringify(outcome.result.content));
  }
  if (!Value.Check(CheckpointOutputSchema, outcome.result.structuredContent)) {
    throw new Error("Invalid native checkpoint output");
  }
  return outcome.result.structuredContent;
}

async function rejectedCheckpoint(
  ctx: ExtensionToolContext,
  input: Checkpoint,
  reason: string,
) {
  let failure: unknown;
  try {
    await checkpoint(ctx, input);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : "").toContain(reason);
}

async function prepare(ctx: ExtensionToolContext, invocationId: string) {
  await checkpoint(ctx, {
    invocationId,
    action: "accept",
    plan: "Offline scoped fixture",
    approval: "No external actions",
    assignments: [
      { id: "a", task: "Fixture", scope: ["src/a.ts"], dependencies: [] },
    ],
  });
  const started = await checkpoint(ctx, {
    invocationId,
    action: "start",
    assignmentId: "a",
  });
  return {
    agent: "executor",
    task: `${started.dispatchPrefix}Offline fixture`,
    schema: JSON.parse(JSON.stringify(WorkerReportSchema)),
  };
}

for (const mode of ["tool", "streaming"] as const) {
  test(`native AgentSession.abort during ${mode} revokes the old packet without before_settle`, async () => {
    const h = await nativeHarness(undefined, mode === "tool");
    let token = "";
    try {
      if (mode === "tool") {
        const parentReady = latch();
        const running = h.run(async (ctx) => {
          token = h.authorize(ctx);
          const input = await prepare(ctx, token);
          const child = ctx.executeTool("subagent", input);
          try {
            await h.childStarted.promise;
            const forbidden: Checkpoint[] = [
              {
                invocationId: token,
                action: "block",
                assignmentId: "a",
                blockers: ["Must not release live writes"],
              },
              {
                invocationId: token,
                action: "repair",
                assignmentId: "a",
                newAssignmentId: "fix",
                task: "Repair",
              },
            ];
            for (const action of forbidden) {
              await rejectedCheckpoint(ctx, action, "active");
            }
            const queued = h.authorize(ctx);
            await rejectedCheckpoint(
              ctx,
              { invocationId: queued, action: "inspect" },
              "active",
            );
          } finally {
            parentReady.resolve();
          }
          await child;
        });
        await parentReady.promise;
        await h.session.abort();
        await running;
      } else {
        await h.run(async (ctx) => {
          token = h.authorize(ctx);
          await prepare(ctx, token);
        });
        h.boundaries.length = 0;
        const streaming = latch();
        const unsubscribe = h.session.subscribe((event) => {
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            streaming.resolve();
          }
        });
        h.provider.setResponses([
          fauxAssistantMessage("Streaming fixture ".repeat(20_000)),
        ]);
        const running = h.session.prompt("Stream offline fixture");
        await streaming.promise;
        await h.session.abort();
        await running;
        unsubscribe();
      }
      expect(h.boundaries).toEqual(["settled"]);
      expect(h.signals.at(-1)?.aborted).toBe(true);
      await h.run(async (ctx) => {
        for (const input of [
          { action: "inspect" },
          {
            action: "repair",
            assignmentId: "a",
            newAssignmentId: "fix",
            task: "Repair",
          },
          { action: "start", assignmentId: "a" },
        ] as const) {
          await rejectedCheckpoint(
            ctx,
            { invocationId: token, ...input },
            "Unauthorized",
          );
        }
        const fresh = h.authorize(ctx);
        const observed = await checkpoint(ctx, {
          invocationId: fresh,
          action: "inspect",
        });
        expect(observed.ledger.assignments[0]?.status).toBe("blocked");
        expect(observed.ledger.assignments[0]?.report).toBeNull();
        await checkpoint(ctx, {
          invocationId: fresh,
          action: "repair",
          assignmentId: "a",
          newAssignmentId: "fix",
          task: "Repair",
        });
        await checkpoint(ctx, {
          invocationId: fresh,
          action: "start",
          assignmentId: "fix",
        });
      });
    } finally {
      h.dispose();
    }
  }, 15_000);
}

for (const mode of ["direct", "nested"] as const) {
  test(`native later-blocked ${mode} dispatch releases only the completed binding`, async () => {
    const calls: string[] = [];
    const results: string[] = [];
    const ends: string[] = [];
    const h = await nativeHarness((pi) => {
      pi.on("tool_call", (event) => {
        if (event.toolName === "subagent") {
          calls.push(event.toolCallId);
          return {
            block: true,
            reason: "Later profile interceptor denied fixture",
          };
        }
      });
      pi.on("tool_result", (event) => {
        if (event.toolName === "subagent") {
          results.push(event.toolCallId);
        }
      });
      pi.on("tool_execution_end", (event) => {
        if (event.toolName === "subagent") {
          expect(event.isError).toBe(true);
          ends.push(event.toolCallId);
        }
      });
    });
    let token = "";
    let input: Awaited<ReturnType<typeof prepare>> | undefined;
    try {
      await h.run(async (ctx) => {
        token = h.authorize(ctx);
        input = await prepare(ctx, token);
        if (mode === "nested") {
          expect((await ctx.executeTool("subagent", input)).isError).toBe(true);
        }
      });
      if (!input) {
        throw new Error("Missing dispatch input");
      }
      if (mode === "direct") {
        h.provider.setResponses([
          fauxAssistantMessage(fauxToolCall("subagent", input), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Denied dispatch settled normally"),
        ]);
        await h.session.prompt("Dispatch offline fixture directly");
      }
      expect(h.childCount()).toBe(0);
      expect(calls).toHaveLength(1);
      expect(results).toEqual([]); // Native blocked calls skip tool_result.
      expect(ends).toEqual(calls);
      await h.run(async (ctx) => {
        // Normal settlement must not revoke authorization.
        const observed = await checkpoint(ctx, {
          invocationId: token,
          action: "inspect",
        });
        expect(observed.ledger.assignments[0]?.status).toBe("blocked");
        expect(observed.ledger.assignments[0]?.report).toBeNull();
        await checkpoint(ctx, {
          invocationId: token,
          action: "block",
          assignmentId: "a",
          blockers: ["Independent reconciliation"],
        });
        const fresh = h.authorize(ctx);
        await checkpoint(ctx, { invocationId: fresh, action: "inspect" });
        await checkpoint(ctx, {
          invocationId: fresh,
          action: "repair",
          assignmentId: "a",
          newAssignmentId: "fix",
          task: "Repair",
        });
        await checkpoint(ctx, {
          invocationId: fresh,
          action: "start",
          assignmentId: "fix",
        });
      });
    } finally {
      h.dispose();
    }
  }, 15_000);
}

test("native successful reports are consumed once and normal continuation keeps authorization", async () => {
  let continueOnce = true;
  const h = await nativeHarness((pi) => {
    pi.on("agent_before_settle", () => {
      if (continueOnce) {
        continueOnce = false;
        return {
          entries: [
            {
              type: "custom_message",
              customType: "fixture-continuation",
              content: "Continue offline fixture",
              display: false,
            },
          ],
          continue: true,
        };
      }
    });
  });
  let token = "";
  try {
    // A real before_settle continuation consumes this extra response.
    await h.run(async (ctx) => {
      token = h.authorize(ctx);
      const input = await prepare(ctx, token);
      expect((await ctx.executeTool("subagent", input)).isError).toBe(false);
      h.provider.appendResponses([fauxAssistantMessage("Continuation")]);
    });
    expect(h.boundaries).toEqual(["before_settle", "before_settle", "settled"]);
    await h.run(async (ctx) => {
      const observed = await checkpoint(ctx, {
        invocationId: token,
        action: "inspect",
      });
      const item = observed.ledger.assignments[0];
      expect(item?.status).toBe("running");
      expect(item?.report).toEqual(report);
      if (!item?.attemptId) {
        throw new Error("Missing attempt");
      }
      await checkpoint(ctx, {
        invocationId: token,
        action: "verify",
        assignmentId: "a",
        attemptId: item.attemptId,
        passed: true,
        evidence: ["Main checked fixture"],
        blockers: [],
      });
    });
  } finally {
    h.dispose();
  }
}, 15_000);
