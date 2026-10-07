import { describe, expect, it } from "bun:test";

import type { Tool as ProviderTool } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { Value } from "typebox/value";

import executeExtension from "./index";
import { LEDGER_ENTRY_TYPE } from "./ledger";
import {
  type Checkpoint,
  CheckpointOutputSchema,
  CheckpointSchema,
  type WorkerReport,
  WorkerReportSchema,
} from "./schema";

type Handler = (event: unknown, ctx: unknown) => unknown;
interface Tool extends Pick<
  ProviderTool,
  "name" | "description" | "parameters"
> {
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: unknown,
  ) => Promise<unknown>;
}
const report: WorkerReport = {
  status: "done",
  summary: "Done",
  filesTouched: ["src/a.ts"],
  validation: ["Worker test passed"],
  followUps: [],
  blockers: [],
};

function harness(branch: unknown[] = []) {
  const hooks = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const messages: Array<{ content: string; options: unknown }> = [];
  const notifications: string[] = [];
  let sessionId = "session";
  let abortCount = 0;
  const ctx = {
    cwd: "/workspace",
    abort: () => {
      abortCount++;
    },
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
      getEntries: () => {
        throw new Error("Must not read all entries");
      },
    },
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  };
  executeExtension({
    on: (name: string, handler: Handler) => {
      hooks.set(name, handler);
    },
    registerTool: (tool: Tool) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, command);
    },
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ type: "custom", customType, data: structuredClone(data) });
    },
    sendUserMessage: (content: string, options: unknown) => {
      messages.push({ content, options });
    },
  } as never);
  async function invoke(busy = false) {
    await commands
      .get("execute")
      ?.handler("Implement A", { ...ctx, isIdle: () => !busy });
    const token = messages
      .at(-1)
      ?.content.match(/invocationId: ([a-f0-9-]{36})$/)?.[1];
    if (!token) {
      throw new Error("Missing authorization token");
    }
    return token;
  }
  async function checkpoint(
    invocationId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const result = await tools
      .get("execute_checkpoint")
      ?.execute(
        "checkpoint-call",
        { invocationId, ...params },
        signal,
        undefined,
        ctx,
      );
    if (
      !result ||
      typeof result !== "object" ||
      !("structuredContent" in result) ||
      !Value.Check(CheckpointOutputSchema, result.structuredContent)
    ) {
      throw new Error("Invalid checkpoint tool output");
    }
    return result.structuredContent;
  }
  async function emit(name: string, event: unknown = {}) {
    return await hooks.get(name)?.(event, ctx);
  }
  async function accept(invocationId: string) {
    return checkpoint(invocationId, {
      action: "accept",
      plan: "Canonical plan",
      approval: "Safe local work",
      assignments: [
        { id: "a", task: "Implement A", scope: ["src/a.ts"], dependencies: [] },
      ],
    });
  }
  async function dispatch(invocationId: string, callId = "child-call") {
    const started = await checkpoint(invocationId, {
      action: "start",
      assignmentId: "a",
    });
    const input = {
      agent: "executor",
      task: `${started.dispatchPrefix}Canonical plan; task; TDD`,
      schema: JSON.parse(JSON.stringify(WorkerReportSchema)),
    };
    expect(
      await emit("tool_call", {
        toolName: "subagent",
        toolCallId: callId,
        input,
      }),
    ).toBeUndefined();
    return { started, input };
  }
  async function childResult(
    callId = "child-call",
    structuredContent: unknown = { runId: "run", structuredOutput: report },
    isError = false,
  ) {
    return emit("tool_result", {
      toolName: "subagent",
      toolCallId: callId,
      structuredContent,
      isError,
    });
  }
  return {
    getAbortCount: () => abortCount,
    tools,
    ctx,
    hooks,
    branch,
    messages,
    notifications,
    invoke,
    checkpoint,
    emit,
    accept,
    dispatch,
    childResult,
    switchSession: (id: string) => {
      sessionId = id;
    },
  };
}

describe("execute native-session integration", () => {
  it("registers an object-root schema for the installed OpenAI converter before /execute", () => {
    const h = harness();
    const registered = h.tools.get("execute_checkpoint");
    if (!registered) {
      throw new Error("Missing execute_checkpoint registration");
    }
    const [tool] = convertResponsesTools([registered]);
    if (tool?.type !== "function") {
      throw new Error("Missing OpenAI function declaration");
    }
    expect(tool.parameters?.type).toBe("object");
    expect(tool.parameters?.anyOf).toBeUndefined();
    expect(tool.parameters?.oneOf).toBeUndefined();
    expect(tool.parameters?.required).toEqual(["invocationId", "action"]);
    expect(tool.parameters?.additionalProperties).toBe(false);
    expect(h.messages).toEqual([]);

    const invocationId = "fixture";
    const calls: Checkpoint[] = [
      { invocationId, action: "inspect" },
      {
        invocationId,
        action: "accept",
        plan: "Plan",
        approval: "Safe local work",
        assignments: [
          { id: "a", task: "Task", scope: ["src/a.ts"], dependencies: [] },
        ],
      },
      { invocationId, action: "start", assignmentId: "a" },
      {
        invocationId,
        action: "verify",
        assignmentId: "a",
        attemptId: "attempt",
        passed: true,
        evidence: ["Main checked"],
        blockers: [],
      },
      {
        invocationId,
        action: "block",
        assignmentId: "a",
        blockers: ["Blocked"],
      },
      {
        invocationId,
        action: "repair",
        assignmentId: "a",
        newAssignmentId: "fix",
        task: "Repair",
      },
      { invocationId, action: "stop" },
    ];
    for (const call of calls) {
      expect(Value.Check(registered.parameters, call)).toBe(true);
      expect(Value.Check(CheckpointSchema, call)).toBe(true);
    }
    for (const invalid of [
      {},
      { invocationId, action: "unknown" },
      { invocationId, action: "inspect", extra: true },
      { invocationId, action: "inspect", assignmentId: "a" },
      { invocationId, action: "start" },
      { invocationId, action: "verify", evidence: [] },
      { invocationId, action: "block", assignmentId: "a", blockers: [] },
    ]) {
      expect(Value.Check(CheckpointSchema, invalid)).toBe(false);
    }
  });

  it("keeps action-specific validation before any ledger mutation", async () => {
    const h = harness();
    const token = await h.invoke();
    for (const params of [
      { action: "inspect", assignmentId: "a" },
      { action: "accept", plan: "Plan" },
      { action: "start" },
      {
        action: "verify",
        assignmentId: "a",
        attemptId: "attempt",
        passed: true,
        evidence: [],
        blockers: [],
      },
      { action: "block", assignmentId: "a", blockers: [] },
      { action: "repair", assignmentId: "a", newAssignmentId: "fix" },
      { action: "stop", task: "Unexpected" },
    ]) {
      expect(h.checkpoint(token, params)).rejects.toThrow("Invalid");
    }
    expect(h.branch).toEqual([]);
  });

  it("cannot release an active child's write reservation or consume a new packet before it settles", async () => {
    const h = harness();
    const token = await h.invoke();
    await h.accept(token);
    await h.dispatch(token);
    expect(
      h.checkpoint(token, {
        action: "block",
        assignmentId: "a",
        blockers: ["Release scope"],
      }),
    ).rejects.toThrow("active");
    const next = await h.invoke(true);
    expect(h.checkpoint(next, { action: "inspect" })).rejects.toThrow("active");
    await h.childResult();
    expect(
      (await h.checkpoint(next, { action: "inspect" })).ledger.assignments[0]
        ?.status,
    ).toBe("blocked");
  });

  it("checkpoint stop aborts the parent operation as well as revoking the ledger", async () => {
    const h = harness();
    const token = await h.invoke();
    await h.accept(token);
    await h.dispatch(token);
    await h.checkpoint(token, { action: "stop" });
    expect(h.getAbortCount()).toBe(1);
  });

  it("rejects checkpoints without explicit session authorization and rejects aborted calls", async () => {
    const h = harness();
    expect(h.checkpoint("invented", { action: "inspect" })).rejects.toThrow(
      "Unauthorized",
    );
    const token = await h.invoke();
    expect(
      h.checkpoint(token, { action: "inspect", extra: true }),
    ).rejects.toThrow("Invalid");
    const controller = new AbortController();
    controller.abort();
    expect(
      h.checkpoint(token, { action: "inspect" }, controller.signal),
    ).rejects.toThrow("cancelled");
    h.switchSession("other-session");
    expect(h.checkpoint(token, { action: "inspect" })).rejects.toThrow(
      "Unauthorized",
    );
  });

  it("records only observed object reports, leaving completion to independent main verification", async () => {
    const h = harness();
    const token = await h.invoke();
    await h.accept(token);
    const { started } = await h.dispatch(token);
    await h.childResult();
    const claimed = await h.checkpoint(token, { action: "inspect" });
    expect(claimed.ledger.assignments[0]?.status).toBe("running");
    expect(claimed.ledger.assignments[0]?.runId).toBe("run");
    expect(claimed.ledger.assignments[0]?.toolCallId).toBe("child-call");
    const complete = await h.checkpoint(token, {
      action: "verify",
      assignmentId: "a",
      attemptId: started.ledger.assignments[0]?.attemptId,
      passed: true,
      evidence: ["Main diff inspected; bun test exit 0"],
      blockers: [],
    });
    expect(complete.ledger.assignments[0]?.status).toBe("completed");
    expect(
      h.branch.every(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "customType" in entry &&
          entry.customType === LEDGER_ENTRY_TYPE,
      ),
    ).toBe(true);
  });

  it("binds nested calls and rejects wrong agent, schema, stale prefix and repeated dispatch", async () => {
    const h = harness();
    const token = await h.invoke();
    await h.accept(token);
    const started = await h.checkpoint(token, {
      action: "start",
      assignmentId: "a",
    });
    const input = {
      agent: "executor",
      task: `${started.dispatchPrefix}Task`,
      schema: JSON.parse(JSON.stringify(WorkerReportSchema)),
    };
    for (const invalid of [
      { ...input, agent: "generic" },
      { ...input, cwd: "/other-checkout" },
      { ...input, schema: {} },
      { ...input, task: "Execution binding: stale/a/attempt\nTask" },
    ]) {
      expect(
        await h.emit("tool_call", {
          toolName: "subagent",
          toolCallId: "invalid",
          input: invalid,
        }),
      ).toMatchObject({ block: true });
    }
    expect(
      await h.emit("tool_call", {
        toolName: "subagent",
        toolCallId: "codemode/1",
        parentToolCallId: "codemode",
        input,
      }),
    ).toBeUndefined();
    expect(
      await h.emit("tool_call", {
        toolName: "subagent",
        toolCallId: "codemode/2",
        parentToolCallId: "codemode",
        input,
      }),
    ).toMatchObject({ block: true });
    await h.childResult("codemode/1");
    expect(
      (await h.checkpoint(token, { action: "inspect" })).ledger.assignments[0]
        ?.report,
    ).toEqual(report);
  });

  it("blocks missing, prose, invalid and failed reports rather than losing originating work", async () => {
    for (const [value, isError] of [
      [null, false],
      [{ runId: "run", structuredOutput: JSON.stringify(report) }, false],
      [
        {
          runId: "run",
          structuredOutput: { ...report, status: "needs_followup" },
        },
        false,
      ],
      [{ runId: "run", structuredOutput: report }, true],
    ] as const) {
      const h = harness();
      const token = await h.invoke();
      await h.accept(token);
      await h.dispatch(token);
      await h.childResult("child-call", value, isError);
      const output = await h.checkpoint(token, { action: "inspect" });
      expect(output.ledger.assignments[0]?.id).toBe("a");
      expect(output.ledger.assignments[0]?.status).toBe("blocked");
      expect(output.ledger.assignments[0]?.blockers.length).toBeGreaterThan(0);
      expect(output.ledger.assignments[0]?.evidence).toEqual([]);
    }
  });

  it("preserves active authorization while a follow-up queues, then revokes the old packet when consumed", async () => {
    const h = harness();
    const first = await h.invoke();
    await h.accept(first);
    await h.dispatch(first);
    const queued = await h.invoke(true);
    expect(h.messages.at(-1)?.options).toEqual({ deliverAs: "followUp" });
    await h.childResult();
    expect(
      (await h.checkpoint(first, { action: "inspect" })).ledger.assignments[0]
        ?.report,
    ).toEqual(report);
    const next = await h.checkpoint(queued, { action: "inspect" });
    expect(next.ledger.assignments[0]?.status).toBe("blocked");
    expect(h.checkpoint(first, { action: "inspect" })).rejects.toThrow(
      "Unauthorized",
    );
  });

  it("does not auto-authorize/replay on reload or tree navigation and ignores stale results", async () => {
    for (const boundary of ["session_start", "session_tree"]) {
      const h = harness();
      const token = await h.invoke();
      await h.accept(token);
      await h.dispatch(token);
      const messageCount = h.messages.length;
      await h.emit(boundary);
      await h.childResult();
      expect(h.messages.length).toBe(messageCount);
      expect(h.checkpoint(token, { action: "inspect" })).rejects.toThrow(
        "Unauthorized",
      );
      const fresh = await h.invoke();
      const output = await h.checkpoint(fresh, { action: "inspect" });
      expect(output.ledger.plan).toBe("Canonical plan");
      expect(output.ledger.assignments[0]?.report).toBeNull();
      expect(output.ledger.assignments[0]?.status).toBe("blocked");
    }
  });

  it("restores selected branch only and fails closed on corrupt and foreign-session data", async () => {
    const original = harness();
    const token = await original.invoke();
    await original.accept(token);
    const branch = [...original.branch];
    await original.dispatch(token);
    await original.childResult();
    const selected = harness(branch);
    await selected.emit("session_tree");
    const newToken = await selected.invoke();
    expect(
      (await selected.checkpoint(newToken, { action: "inspect" })).ledger
        .assignments[0]?.status,
    ).toBe("pending");
    for (const data of [
      null,
      {
        ...(await original.checkpoint(token, { action: "inspect" })).ledger,
        sessionId: "foreign",
      },
    ]) {
      const invalid = harness([
        { type: "custom", customType: LEDGER_ENTRY_TYPE, data },
      ]);
      await invalid.emit("session_start");
      const fresh = await invalid.invoke();
      expect(
        invalid.checkpoint(fresh, { action: "inspect" }),
      ).rejects.toThrow();
    }
  });

  it("revokes on stop, abort/error settlement and shutdown without automatic continuation", async () => {
    for (const mode of ["stop", "abort", "error", "shutdown"]) {
      const h = harness();
      const token = await h.invoke();
      await h.accept(token);
      await h.dispatch(token);
      if (mode === "stop") {
        await h.checkpoint(token, { action: "stop" });
      } else {
        await h.emit(
          mode === "shutdown" ? "session_shutdown" : "agent_before_settle",
          { outcome: mode === "abort" ? "aborted" : "error" },
        );
      }
      await h.childResult();
      expect(h.checkpoint(token, { action: "inspect" })).rejects.toThrow(
        "Unauthorized",
      );
      expect(h.messages.length).toBe(1);
      const fresh = await h.invoke();
      const output = await h.checkpoint(fresh, { action: "inspect" });
      expect(output.ledger.assignments[0]?.status).toBe("blocked");
      expect(output.ledger.assignments[0]?.report).toBeNull();
    }
  });

  it("does not accept stale results after a new invocation or a session switch", async () => {
    const h = harness();
    const first = await h.invoke();
    await h.accept(first);
    await h.dispatch(first);
    const next = await h.invoke();
    expect(h.checkpoint(next, { action: "inspect" })).rejects.toThrow("active");
    h.switchSession("other-session");
    await h.childResult();
    h.switchSession("session");
    expect(
      (await h.checkpoint(next, { action: "inspect" })).ledger.assignments[0]
        ?.report,
    ).toBeNull();
    expect(h.notifications.some((note) => note.includes("Stale"))).toBe(true);
    h.switchSession("other-session");
    await h.childResult("unbound-call");
    expect(h.checkpoint(next, { action: "inspect" })).rejects.toThrow(
      "Unauthorized",
    );
  });

  it("can accept a new plan only after all effective assignments are independently completed", async () => {
    const h = harness();
    const first = await h.invoke();
    await h.accept(first);
    const { started } = await h.dispatch(first);
    await h.childResult();
    await h.checkpoint(first, {
      action: "verify",
      assignmentId: "a",
      attemptId: started.ledger.assignments[0]?.attemptId,
      passed: true,
      evidence: ["Main tests exit 0"],
      blockers: [],
    });
    const next = await h.invoke();
    expect((await h.accept(next)).ledger.assignments[0]?.status).toBe(
      "pending",
    );
  });
});
