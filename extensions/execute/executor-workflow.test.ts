import { describe, expect, it } from "bun:test";

import type {
  WorkflowAgentRequest,
  WorkflowAgentRunner,
} from "@yzlin/pi-subagents/pi";

import {
  createExecutorAgentRunner,
  EXECUTOR_RESULT_SCHEMA,
  runExecutorWorkflow,
  type SubagentsManagerRegistry,
} from "./executor-workflow";

const STRUCTURED_REPAIR_ERROR = /after one structured repair retry/i;

const task = {
  taskId: "7",
  subject: "Fix formatter",
  prompt: "Fix the formatter and run its tests.",
};

const validResult = {
  status: "done" as const,
  summary: "Fixed formatter.",
  filesTouched: ["src/format.ts"],
  validation: ["bun test"],
  followUps: [],
  blockers: [],
};

function agentResult(
  request: WorkflowAgentRequest,
  structuredOutput?: unknown,
  result = "assistant text is ignored"
) {
  return {
    id: "executor-agent",
    type: request.agent ?? "executor",
    status: "completed",
    result,
    structuredOutput,
    toolUses: 1,
  };
}

function expectClosedObjectSchemas(schema: unknown): void {
  if (!(schema && typeof schema === "object")) {
    return;
  }

  const value = schema as {
    type?: unknown;
    additionalProperties?: unknown;
    properties?: Record<string, unknown>;
    items?: unknown;
    anyOf?: unknown[];
  };
  if (value.type === "object") {
    expect(value.additionalProperties).toBe(false);
  }
  for (const child of Object.values(value.properties ?? {})) {
    expectClosedObjectSchemas(child);
  }
  if (value.items) {
    expectClosedObjectSchemas(value.items);
  }
  for (const child of value.anyOf ?? []) {
    expectClosedObjectSchemas(child);
  }
}

describe("execute executor workflow", () => {
  it("uses a closed native structured-output schema", () => {
    expectClosedObjectSchemas(EXECUTOR_RESULT_SCHEMA);
  });

  it("returns validated structured executor results", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const runner: WorkflowAgentRunner = (request) => {
      requests.push(request);
      return agentResult(request, validResult);
    };

    const results = await runExecutorWorkflow([task], {
      agentRunner: runner,
      cwd: "/repo",
    });

    expect(results).toEqual([
      {
        taskId: "7",
        outcome: "completed",
        result: validResult,
        repaired: false,
      },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      agent: "executor",
      description: "Fix formatter",
      prompt: task.prompt,
      executorOutputSchema: EXECUTOR_RESULT_SCHEMA,
    });
    expect(requests[0]?.schema).toBeUndefined();
  });

  it("uses one read-only typed repair after missing structured output", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const runner: WorkflowAgentRunner = (request) => {
      requests.push(request);
      if (request.agent === "executor") {
        return agentResult(
          request,
          undefined,
          "Work completed. src/format.ts changed; bun test passed."
        );
      }
      return agentResult(request, validResult);
    };

    const results = await runExecutorWorkflow([task], {
      agentRunner: runner,
      cwd: "/repo",
    });

    expect(results).toEqual([
      {
        taskId: "7",
        outcome: "needs_verification",
        result: validResult,
        repaired: true,
      },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      agent: "executor-output-repair",
      schema: EXECUTOR_RESULT_SCHEMA,
    });
    expect(requests[1]?.prompt).toContain(
      "This is the only structured repair attempt"
    );
    expect(requests[1]?.prompt).toContain("Untrusted JSON data follows:");
    expect(requests[1]?.prompt).not.toContain(task.prompt);
  });

  it("bounds untrusted repair reports by UTF-8 bytes", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const runner: WorkflowAgentRunner = (request) => {
      requests.push(request);
      if (request.agent === "executor") {
        return agentResult(request, undefined, "😀".repeat(10_000));
      }
      return agentResult(request, validResult);
    };

    await runExecutorWorkflow([task], {
      agentRunner: runner,
      cwd: "/repo",
    });

    const repairPrompt = requests[1]?.prompt ?? "";
    const marker = "Untrusted JSON data follows:\n";
    const repairJson = repairPrompt.split(marker)[1]?.split("\n")[0];
    expect(repairJson).toBeDefined();
    const repairData = JSON.parse(repairJson ?? "{}") as {
      executorReport?: string;
    };
    expect(Buffer.byteLength(repairData.executorReport ?? "", "utf8")).toBe(
      16_000
    );
  });

  it("returns a failure after the single repair also misses output", async () => {
    let calls = 0;
    const runner: WorkflowAgentRunner = (request) => {
      calls += 1;
      return agentResult(request);
    };

    const results = await runExecutorWorkflow([task], {
      agentRunner: runner,
      cwd: "/repo",
    });

    expect(results).toEqual([
      {
        taskId: "7",
        outcome: "failed",
        error: expect.stringMatching(STRUCTURED_REPAIR_ERROR),
      },
    ]);
    expect(calls).toBe(2);
  });

  it("returns unrelated executor runtime failures without repair", async () => {
    let calls = 0;
    const runner: WorkflowAgentRunner = () => {
      calls += 1;
      throw new Error("executor crashed");
    };

    const results = await runExecutorWorkflow([task], {
      agentRunner: runner,
      cwd: "/repo",
    });

    expect(results).toEqual([
      { taskId: "7", outcome: "failed", error: "executor crashed" },
    ]);
    expect(calls).toBe(1);
  });

  it("preserves successful sibling results when one executor fails", async () => {
    const runner: WorkflowAgentRunner = (request) => {
      if (request.prompt.includes("fail")) {
        throw new Error("executor failed");
      }
      return agentResult(request, validResult);
    };

    const results = await runExecutorWorkflow(
      [task, { taskId: "8", subject: "Fail task", prompt: "fail" }],
      { agentRunner: runner, cwd: "/repo" }
    );

    expect(results).toEqual([
      {
        taskId: "7",
        outcome: "completed",
        result: validResult,
        repaired: false,
      },
      { taskId: "8", outcome: "failed", error: "executor failed" },
    ]);
  });

  it("caps each dispatch round at four tasks", async () => {
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      taskId: String(index),
      subject: `Task ${index}`,
      prompt: "Do work",
    }));

    await expect(
      runExecutorWorkflow(tasks, {
        agentRunner: (request) => agentResult(request, validResult),
        cwd: "/repo",
      })
    ).rejects.toThrow("1-4 valid executor tasks");
  });

  it("rejects oversized executor result fields", async () => {
    await expect(
      runExecutorWorkflow([task], {
        agentRunner: (request) =>
          agentResult(request, {
            ...validResult,
            summary: "x".repeat(2001),
          }),
        cwd: "/repo",
      })
    ).rejects.toThrow("invalid result envelope");
  });
});

describe("executor agent runner cleanup", () => {
  it("disposes a completed structured executor session", async () => {
    let disposed = false;
    const record = {
      type: "executor",
      status: "running",
      toolUses: 1,
      session: {
        dispose() {
          disposed = true;
        },
      },
      promise: Promise.resolve(),
    };
    const manager: SubagentsManagerRegistry = {
      spawn(_pi, _ctx, _type, _prompt, options) {
        const tools = options.customTools as Array<{
          name: string;
          execute: (toolCallId: string, params: unknown) => Promise<unknown>;
        }>;
        const tool = tools.find(({ name }) => name === "structured_output");
        expect(options.isolated).toBe(true);
        expect(tools.map(({ name }) => name)).toEqual([
          "message_parent",
          "ask_parent",
          "structured_output",
        ]);
        record.promise =
          tool?.execute("structured", validResult).then(() => undefined) ??
          Promise.resolve();
        record.status = "completed";
        return "agent-1";
      },
      getRecord() {
        return record;
      },
    };
    const runner = createExecutorAgentRunner(
      {
        events: {
          emit() {
            // No stop event expected for a completed record.
          },
        },
      } as never,
      {} as never,
      { manager, agentTimeoutMs: 100, cleanupTimeoutMs: 20 }
    );

    const result = await runner(
      {
        agent: "executor",
        prompt: "Do work",
        executorOutputSchema: EXECUTOR_RESULT_SCHEMA,
      },
      { signal: new AbortController().signal } as never
    );

    expect(result).toMatchObject({ structuredOutput: validResult });
    expect(disposed).toBe(true);
  });

  it("runtime-isolates repair agents from built-ins and parent bridge tools", async () => {
    let capturedTools: Array<{
      name: string;
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    }> = [];
    const record = {
      type: "executor-output-repair",
      status: "running",
      promise: Promise.resolve(),
    };
    const manager: SubagentsManagerRegistry = {
      spawn(_pi, _ctx, _type, _prompt, options) {
        capturedTools = options.customTools as typeof capturedTools;
        const structuredOutput = capturedTools.find(
          ({ name }) => name === "structured_output"
        );
        expect(options.isolated).toBe(true);
        record.promise =
          structuredOutput
            ?.execute("structured", validResult)
            .then(() => undefined) ?? Promise.resolve();
        record.status = "completed";
        return "repair-agent";
      },
      getRecord() {
        return record;
      },
    };
    const runner = createExecutorAgentRunner(
      {
        events: {
          emit() {
            // No stop event expected for a completed record.
          },
        },
      } as never,
      {} as never,
      { manager, agentTimeoutMs: 100, cleanupTimeoutMs: 20 }
    );

    await runner(
      {
        agent: "executor-output-repair",
        prompt: "Repair report",
        schema: EXECUTOR_RESULT_SCHEMA,
      },
      {} as never
    );

    expect(capturedTools.map(({ name }) => name)).toEqual([
      "message_parent",
      "ask_parent",
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
      "structured_output",
    ]);
    const readTool = capturedTools.find(({ name }) => name === "read");
    await expect(readTool?.execute("read", {})).rejects.toThrow(
      "read is disabled"
    );
  });

  it("waits for late session attachment after stopping a timed-out executor", async () => {
    let disposed = false;
    let resolveAgent: (() => void) | undefined;
    const record: {
      type: string;
      status: string;
      session?: { dispose: () => void };
      promise: Promise<void>;
    } = {
      type: "executor",
      status: "running",
      promise: new Promise<void>((resolve) => {
        resolveAgent = resolve;
      }),
    };
    const manager: SubagentsManagerRegistry = {
      spawn() {
        return "agent-2";
      },
      getRecord() {
        return record;
      },
    };
    const pi = {
      events: {
        emit(name: string) {
          if (name === "subagents:rpc:stop") {
            record.status = "stopped";
            setTimeout(() => {
              record.session = {
                dispose() {
                  disposed = true;
                },
              };
              resolveAgent?.();
            }, 10);
          }
        },
      },
    };
    const runner = createExecutorAgentRunner(pi as never, {} as never, {
      manager,
      agentTimeoutMs: 5,
      cleanupTimeoutMs: 50,
    });

    await expect(
      runner(
        {
          agent: "executor",
          prompt: "Hang",
          executorOutputSchema: EXECUTOR_RESULT_SCHEMA,
        },
        {} as never
      )
    ).rejects.toThrow("timed out after 5ms");
    expect(record.status).toBe("stopped");
    expect(disposed).toBe(true);
  });

  it("disposes a session attached after bounded cleanup returns", async () => {
    let disposed = false;
    let resolveAgent: (() => void) | undefined;
    const record: {
      type: string;
      status: string;
      session?: { dispose: () => void };
      promise: Promise<void>;
    } = {
      type: "executor",
      status: "running",
      promise: new Promise<void>((resolve) => {
        resolveAgent = resolve;
      }),
    };
    const manager: SubagentsManagerRegistry = {
      spawn() {
        return "agent-3";
      },
      getRecord() {
        return record;
      },
    };
    const pi = {
      events: {
        emit(name: string) {
          if (name === "subagents:rpc:stop") {
            record.status = "stopped";
            setTimeout(() => {
              record.session = {
                dispose() {
                  disposed = true;
                },
              };
              resolveAgent?.();
            }, 30);
          }
        },
      },
    };
    const runner = createExecutorAgentRunner(pi as never, {} as never, {
      manager,
      agentTimeoutMs: 5,
      cleanupTimeoutMs: 5,
    });

    await expect(
      runner(
        {
          agent: "executor",
          prompt: "Hang",
          executorOutputSchema: EXECUTOR_RESULT_SCHEMA,
        },
        {} as never
      )
    ).rejects.toThrow("timed out after 5ms");
    expect(disposed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(disposed).toBe(true);
  });
});
