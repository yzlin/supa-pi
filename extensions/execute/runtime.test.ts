import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Tool as ProviderTool } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { Value } from "typebox/value";

import { SPEC_DRAFTED_ENTRY_TYPE } from "./constants";
import executeExtension from "./index";
import { LEDGER_ENTRY_TYPE } from "./ledger";
import {
  type Checkpoint,
  CheckpointOutputSchema,
  CheckpointSchema,
  type WorkerReport,
  WorkerReportSchema,
} from "./schema";
import {
  appendSpecEvents,
  hashSpec,
  INTERRUPTED_BLOCKER,
  readSpecLog,
} from "./spec-log";

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

function harness(branch: unknown[] = [], cwd = "/workspace") {
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
    cwd,
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
  async function accept(
    invocationId: string,
    extra: Record<string, unknown> = {},
  ) {
    return checkpoint(invocationId, {
      action: "accept",
      plan: "Canonical plan",
      approval: "Safe local work",
      assignments: [
        { id: "a", task: "Implement A", scope: ["src/a.ts"], dependencies: [] },
      ],
      ...extra,
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

const temporaryWorkspaces: string[] = [];
afterEach(() => {
  for (const directory of temporaryWorkspaces.splice(0)) {
    execFileSync("trash", [directory]);
  }
});

function specHarness(git = false) {
  const cwd = mkdtempSync(join(tmpdir(), "execute-spec-"));
  temporaryWorkspaces.push(cwd);
  mkdirSync(join(cwd, ".pi/specs"), { recursive: true });
  const specPath = ".pi/specs/test.md";
  const logPath = join(cwd, ".pi/specs/test.log.jsonl");
  const content = "# Execution Brief\nCanonical plan";
  writeFileSync(join(cwd, specPath), content);
  if (git) {
    execFileSync("git", ["-C", cwd, "init", "-q"]);
    writeFileSync(join(cwd, ".gitignore"), ".pi/specs/\n");
    execFileSync("git", ["-C", cwd, "add", ".gitignore"]);
    execFileSync("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-qm",
      "Initial",
    ]);
    writeFileSync(join(cwd, "untracked.txt"), "Snapshot me");
  }
  return { ...harness([], cwd), specPath, logPath, content };
}

async function verifyA(h: ReturnType<typeof specHarness>, token: string) {
  const { started } = await h.dispatch(token);
  await h.childResult();
  return h.checkpoint(token, {
    action: "verify",
    assignmentId: "a",
    attemptId: started.ledger.assignments[0]?.attemptId,
    passed: true,
    evidence: ["Main test exit 0"],
    blockers: [],
  });
}

function seedVerified(h: ReturnType<typeof specHarness>) {
  appendSpecEvents(h.logPath, [
    {
      event: "accepted",
      ts: new Date().toISOString(),
      hash: hashSpec(h.content),
      invocationId: "old",
      assignments: [{ id: "a", dependencies: [] }],
    },
    {
      event: "verified",
      ts: new Date().toISOString(),
      assignment: "fix-a",
      lineageId: "a",
      repairCount: 1,
      priorRepairs: 0,
      resumed: false,
      evidence: ["Old verification"],
      head: null,
      snapshot: null,
    },
  ]);
}

describe("Spec runtime", () => {
  it("logs acceptance, start, verification snapshots and done cleanup", async () => {
    const h = specHarness(true);
    const token = await h.invoke();
    await h.accept(token, {
      specPath: h.specPath,
      assignments: [
        { id: "a", task: "A", scope: ["src/a.ts"], dependencies: [] },
        { id: "b", task: "B", scope: ["src/b.ts"], dependencies: ["a"] },
      ],
    });
    expect(readSpecLog(h.logPath)).toEqual([
      {
        event: "accepted",
        ts: expect.any(String),
        hash: hashSpec(h.content),
        invocationId: token,
        assignments: [
          { id: "a", dependencies: [] },
          { id: "b", dependencies: ["a"] },
        ],
      },
    ]);
    await verifyA(h, token);
    const events = readSpecLog(h.logPath);
    expect(events.map((event) => event.event)).toEqual([
      "accepted",
      "started",
      "verified",
    ]);
    expect(events[2]).toMatchObject({
      head: expect.any(String),
      snapshot: "refs/pi-specs/test/1",
    });
    expect(
      execFileSync(
        "git",
        ["-C", h.ctx.cwd, "show", "refs/pi-specs/test/1:untracked.txt"],
        { encoding: "utf8" },
      ),
    ).toBe("Snapshot me");
    const started = await h.checkpoint(token, {
      action: "start",
      assignmentId: "b",
    });
    await h.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "b-call",
      input: {
        agent: "executor",
        task: `${started.dispatchPrefix}B`,
        schema: JSON.parse(JSON.stringify(WorkerReportSchema)),
      },
    });
    await h.childResult("b-call", { runId: "b-run", structuredOutput: report });
    await h.checkpoint(token, {
      action: "verify",
      assignmentId: "b",
      attemptId: started.ledger.assignments[1]?.attemptId,
      passed: true,
      evidence: ["Main B checked"],
      blockers: [],
    });
    expect(readSpecLog(h.logPath).map((event) => event.event)).toEqual([
      "accepted",
      "started",
      "verified",
      "started",
      "verified",
      "done",
    ]);
    expect(readSpecLog(h.logPath)[4]).toMatchObject({
      snapshot: "refs/pi-specs/test/2",
    });
    expect(
      execFileSync(
        "git",
        [
          "-C",
          h.ctx.cwd,
          "for-each-ref",
          "--format=%(refname)",
          "refs/pi-specs/test/",
        ],
        { encoding: "utf8" },
      ),
    ).toBe("");
  });

  it("fails closed on corrupt logs, missing files and invalid paths", async () => {
    for (const [mode, path, error] of [
      ["corrupt", ".pi/specs/test.md", "Corrupt Spec log"],
      ["missing", ".pi/specs/missing.md", "Spec not found"],
      ["invalid", "../test.md", "Invalid Spec path"],
    ]) {
      const h = specHarness();
      const token = await h.invoke();
      if (mode === "corrupt") {
        writeFileSync(h.logPath, "not json\n");
      }
      expect(h.accept(token, { specPath: path })).rejects.toThrow(error);
      expect(h.branch).toEqual([]);
    }
  });

  it("rejects changed hashes and only permits explicit revisions of changed Specs", async () => {
    const h = specHarness();
    seedVerified(h);
    const token = await h.invoke();
    expect(
      h.accept(token, { specPath: h.specPath, reviseSpec: true }),
    ).rejects.toThrow("reviseSpec is only valid when the Spec changed");
    expect(h.accept(token, { reviseSpec: true })).rejects.toThrow(
      "reviseSpec requires specPath",
    );
    writeFileSync(join(h.ctx.cwd, h.specPath), "Changed Spec");
    expect(h.accept(token, { specPath: h.specPath })).rejects.toThrow(
      "Spec changed since it was accepted",
    );
    expect(h.branch).toEqual([]);
    await h.accept(token, { specPath: h.specPath, reviseSpec: true });
    const events = readSpecLog(h.logPath);
    expect(events.slice(-2).map((event) => event.event)).toEqual([
      "revised",
      "accepted",
    ]);
    expect(events.at(-2)).toMatchObject({
      hash: hashSpec("Changed Spec"),
      previousHash: hashSpec(h.content),
    });
  });

  it("derives fresh-ledger reverify and repair budget only from the log", async () => {
    const h = specHarness();
    seedVerified(h);
    const token = await h.invoke();
    const accepted = await h.accept(token, { specPath: h.specPath });
    expect(accepted.ledger.assignments[0]).toMatchObject({
      status: "reverify",
      priorRepairs: 1,
      resumed: true,
    });
    await h.checkpoint(token, {
      action: "verify",
      assignmentId: "a",
      passed: false,
      evidence: ["Fresh test failed"],
      blockers: ["Fix needed"],
    });
    await h.checkpoint(token, {
      action: "repair",
      assignmentId: "a",
      newAssignmentId: "fix",
      task: "Fix",
    });
    await h.checkpoint(token, {
      action: "block",
      assignmentId: "fix",
      blockers: ["Still broken"],
    });
    expect(
      h.checkpoint(token, {
        action: "repair",
        assignmentId: "fix",
        newAssignmentId: "fix2",
        task: "Fix again",
      }),
    ).rejects.toThrow("budget exhausted");
    expect(readSpecLog(h.logPath).map((event) => event.event)).toEqual([
      "accepted",
      "verified",
      "accepted",
      "blocked",
      "repaired",
      "blocked",
    ]);
  });

  it("restores interrupted and exhausted lineages as blocked across sessions", async () => {
    const h = specHarness();
    const first = await h.invoke();
    await h.accept(first, { specPath: h.specPath });
    await h.dispatch(first);
    // A fresh session resumes after the running child was interrupted.
    const resuming = harness([], h.ctx.cwd);
    const token = await resuming.invoke();
    const resumed = await resuming.accept(token, { specPath: h.specPath });
    expect(resumed.ledger.assignments[0]).toMatchObject({
      status: "blocked",
      blockers: [INTERRUPTED_BLOCKER],
      priorRepairs: 0,
    });
    expect(
      resuming.checkpoint(token, { action: "start", assignmentId: "a" }),
    ).rejects.toThrow("Only pending assignments can start");
    const repaired = await resuming.checkpoint(token, {
      action: "repair",
      assignmentId: "a",
      newAssignmentId: "fix",
      task: "Fix",
    });
    expect(repaired.ledger.assignments.at(-1)).toMatchObject({
      repairCount: 1,
      priorRepairs: 0,
    });
    await resuming.checkpoint(token, {
      action: "block",
      assignmentId: "fix",
      blockers: ["Still broken"],
    });
    await resuming.checkpoint(token, {
      action: "repair",
      assignmentId: "fix",
      newAssignmentId: "fix2",
      task: "Fix again",
    });
    await resuming.checkpoint(token, {
      action: "block",
      assignmentId: "fix2",
      blockers: ["Still broken"],
    });
    expect(readSpecLog(h.logPath).slice(-6)).toMatchObject([
      { event: "accepted" },
      { event: "blocked", assignment: "a", blockers: [INTERRUPTED_BLOCKER] },
      { event: "repaired", assignment: "fix" },
      { event: "blocked", assignment: "fix" },
      { event: "repaired", assignment: "fix2" },
      { event: "blocked", assignment: "fix2", repairCount: 2 },
    ]);
    // Every later re-run keeps the exhausted lineage blocked.
    for (let run = 0; run < 2; run++) {
      const again = harness([], h.ctx.cwd);
      const next = await again.invoke();
      const exhausted = await again.accept(next, { specPath: h.specPath });
      expect(exhausted.ledger.assignments[0]).toMatchObject({
        status: "blocked",
        blockers: ["Still broken"],
        priorRepairs: 2,
      });
      expect(
        again.checkpoint(next, { action: "start", assignmentId: "a" }),
      ).rejects.toThrow("Only pending assignments can start");
      expect(
        again.checkpoint(next, {
          action: "repair",
          assignmentId: "a",
          newAssignmentId: "fix3",
          task: "Fix once more",
        }),
      ).rejects.toThrow("budget exhausted");
    }
    expect(
      readSpecLog(h.logPath).filter((event) => event.event === "started"),
    ).toHaveLength(1);
  });

  it("resumes an unchanged Spec after a revision dropped a verified lineage", async () => {
    const h = specHarness();
    const b = { id: "b", task: "B", scope: ["src/b.ts"], dependencies: [] };
    const first = await h.invoke();
    await h.accept(first, {
      specPath: h.specPath,
      assignments: [
        { id: "a", task: "A", scope: ["src/a.ts"], dependencies: [] },
        b,
      ],
    });
    await verifyA(h, first);
    writeFileSync(join(h.ctx.cwd, h.specPath), "Revised Spec without A");
    // Fresh sessions start with empty ledgers, as a later /execute would.
    const revising = harness([], h.ctx.cwd);
    await revising.accept(await revising.invoke(), {
      specPath: h.specPath,
      reviseSpec: true,
      assignments: [b],
    });
    const resuming = harness([], h.ctx.cwd);
    const resumed = await resuming.accept(await resuming.invoke(), {
      specPath: h.specPath,
      assignments: [b],
    });
    expect(
      resumed.ledger.assignments.map(({ id, status }) => ({ id, status })),
    ).toEqual([{ id: "b", status: "pending" }]);
  });

  it("logs resumed verification with null snapshots outside git", async () => {
    const h = specHarness();
    seedVerified(h);
    const token = await h.invoke();
    await h.accept(token, { specPath: h.specPath });
    await h.checkpoint(token, {
      action: "verify",
      assignmentId: "a",
      passed: true,
      evidence: ["Fresh read-only check"],
      blockers: [],
    });
    expect(readSpecLog(h.logPath).at(-2)).toMatchObject({
      event: "verified",
      resumed: true,
      head: null,
      snapshot: null,
    });
    expect(readSpecLog(h.logPath).at(-1)?.event).toBe("done");
  });

  it("logs stop and every hook interruption without duplicate start events", async () => {
    for (const mode of [
      "stop",
      "shutdown",
      "error",
      "signal",
      "result",
      "end",
      "blocked-report",
    ]) {
      const h = specHarness();
      const token = await h.invoke();
      await h.accept(token, { specPath: h.specPath });
      await h.dispatch(token);
      if (mode === "stop") {
        await h.checkpoint(token, { action: "stop" });
      }
      if (mode === "shutdown") {
        // Native shutdown supplies no context.
        await h.hooks.get("session_shutdown")?.({}, undefined);
      }
      if (mode === "error") {
        await h.emit("agent_before_settle", { outcome: "error" });
      }
      if (mode === "signal") {
        const controller = new AbortController();
        await h.hooks.get("agent_start")?.(
          {},
          { ...h.ctx, signal: controller.signal },
        );
        controller.abort();
      }
      if (mode === "result") {
        await h.childResult("child-call", null);
      }
      if (mode === "end") {
        await h.emit("tool_execution_end", {
          toolName: "subagent",
          toolCallId: "child-call",
          isError: true,
        });
      }
      if (mode === "blocked-report") {
        await h.childResult("child-call", {
          runId: "run",
          structuredOutput: {
            ...report,
            status: "blocked",
            blockers: ["Missing prerequisite"],
          },
        });
      }
      expect(readSpecLog(h.logPath).map((event) => event.event)).toEqual([
        "accepted",
        "started",
        "blocked",
        ...(mode === "stop" ? ["stopped"] : []),
      ]);
    }
  });

  it("keeps checkpoint ledger unchanged on log failure; hook failures notify and persist", async () => {
    const h = specHarness();
    const token = await h.invoke();
    await h.accept(token, { specPath: h.specPath });
    writeFileSync(h.logPath, "corrupt\n");
    const before = structuredClone(h.branch);
    expect(
      h.checkpoint(token, { action: "start", assignmentId: "a" }),
    ).rejects.toThrow("Corrupt Spec log");
    expect(h.branch).toEqual(before);
    writeFileSync(h.logPath, "");
    appendSpecEvents(h.logPath, [
      {
        event: "accepted",
        ts: new Date().toISOString(),
        hash: hashSpec(h.content),
        invocationId: token,
        assignments: [{ id: "a", dependencies: [] }],
      },
    ]);
    await h.dispatch(token);
    writeFileSync(h.logPath, "corrupt\n");
    await h.childResult("child-call", null);
    expect(
      h.notifications.some((note) => note.includes("Corrupt Spec log")),
    ).toBe(true);
    expect(h.branch.at(-1)).toMatchObject({
      data: { assignments: [{ status: "blocked" }] },
    });
    // Inspection still returns the ledger and names the log failure.
    const notified = h.notifications.length;
    const inspected = await h.checkpoint(token, { action: "inspect" });
    expect(inspected.ledger.assignments[0]?.status).toBe("blocked");
    expect(
      h.notifications
        .slice(notified)
        .some((note) => note.includes("Spec log failed: Corrupt Spec log")),
    ).toBe(true);
  });

  it("stops, revokes and aborts once despite a corrupt or headless Spec log", async () => {
    for (const mode of ["invalid", "headless"]) {
      const h = specHarness();
      const token = await h.invoke();
      await h.accept(token, { specPath: h.specPath });
      await h.dispatch(token);
      const corrupt =
        mode === "invalid"
          ? "corrupt\n"
          : `${JSON.stringify({ event: "stopped", ts: new Date().toISOString(), reason: "Orphan" })}\n`;
      writeFileSync(h.logPath, corrupt);
      await h.checkpoint(token, { action: "stop" });
      expect(h.getAbortCount()).toBe(1);
      expect(h.branch.at(-1)).toMatchObject({
        data: { assignments: [{ status: "blocked" }] },
      });
      expect(
        h.notifications.some((note) =>
          note.includes("Spec log failed: Corrupt Spec log"),
        ),
      ).toBe(true);
      expect(readFileSync(h.logPath, "utf8")).toBe(corrupt);
      expect(h.checkpoint(token, { action: "inspect" })).rejects.toThrow(
        "Unauthorized",
      );
    }
  });

  it("persists hook changes despite log errors, including binding, reports and shutdown", async () => {
    for (const mode of ["bind", "report", "end", "abort", "shutdown"]) {
      const h = specHarness();
      const token = await h.invoke();
      await h.accept(token, { specPath: h.specPath });
      const started = await h.checkpoint(token, {
        action: "start",
        assignmentId: "a",
      });
      const input = {
        agent: "executor",
        task: `${started.dispatchPrefix}Task`,
        schema: JSON.parse(JSON.stringify(WorkerReportSchema)),
      };
      if (mode !== "bind") {
        await h.emit("tool_call", {
          toolName: "subagent",
          toolCallId: "child-call",
          input,
        });
      }
      writeFileSync(h.logPath, "corrupt\n");
      if (mode === "bind") {
        expect(
          await h.emit("tool_call", {
            toolName: "subagent",
            toolCallId: "child-call",
            input,
          }),
        ).toBeUndefined();
        expect(h.branch.at(-1)).toMatchObject({
          data: { assignments: [{ toolCallId: "child-call" }] },
        });
      } else if (mode === "report") {
        await h.childResult();
        expect(h.branch.at(-1)).toMatchObject({
          data: { assignments: [{ status: "running", report }] },
        });
      } else {
        if (mode === "end") {
          await h.emit("tool_execution_end", {
            toolName: "subagent",
            toolCallId: "child-call",
            isError: true,
          });
        } else if (mode === "abort") {
          await h.emit("agent_before_settle", { outcome: "aborted" });
        } else {
          await h.hooks.get("session_shutdown")?.({}, undefined);
        }
        expect(h.branch.at(-1)).toMatchObject({
          data: { assignments: [{ status: "blocked" }] },
        });
      }
      if (mode !== "shutdown") {
        expect(
          h.notifications.some((note) =>
            note.includes("Spec log failed: Corrupt Spec log"),
          ),
        ).toBe(true);
      }
    }
  });

  it("warns on Snapshot ref cleanup failure after done without failing verify", async () => {
    const h = specHarness(true);
    // A held ref lock makes `git update-ref -d` fail during done cleanup.
    execFileSync("git", [
      "-C",
      h.ctx.cwd,
      "update-ref",
      "refs/pi-specs/test/stale",
      "HEAD",
    ]);
    writeFileSync(join(h.ctx.cwd, ".git/refs/pi-specs/test/stale.lock"), "");
    const token = await h.invoke();
    await h.accept(token, { specPath: h.specPath });
    await verifyA(h, token);
    expect(h.branch.at(-1)).toMatchObject({
      data: { assignments: [{ status: "completed" }] },
    });
    expect(
      h.notifications.some((note) =>
        note.startsWith("Spec snapshot cleanup failed: Command failed: git -C"),
      ),
    ).toBe(true);
    const events = readSpecLog(h.logPath).map((event) => event.event);
    expect(events.filter((event) => event === "verified")).toHaveLength(1);
    expect(events.filter((event) => event === "done")).toHaveLength(1);
  });

  it("does not write logs for ordinary ledgers", async () => {
    const h = specHarness();
    const token = await h.invoke();
    await h.accept(token);
    await verifyA(h, token);
    await h.checkpoint(token, { action: "stop" });
    expect(existsSync(h.logPath)).toBe(false);
  });
});

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

  describe("assignment cwd", () => {
    function cwdHarness() {
      const root = mkdtempSync(join(tmpdir(), "execute-cwd-"));
      temporaryWorkspaces.push(root);
      const cwd = join(root, "workspace");
      mkdirSync(join(cwd, "packages/x"), { recursive: true });
      mkdirSync(join(root, "sibling/lib"), { recursive: true });
      const h = harness([], cwd);
      const prompts: string[] = [];
      const state = { answer: false };
      Object.assign(h.ctx.ui, {
        confirm: async (_title: string, message: string) => {
          prompts.push(message);
          return state.answer;
        },
      });
      const sibling = realpathSync(join(root, "sibling"));
      return { h, root, cwd, prompts, state, sibling };
    }
    const assignment = (
      id: string,
      scope: string[],
      cwd?: string,
    ): Record<string, unknown> => ({
      id,
      task: `Implement ${id}`,
      scope,
      dependencies: [],
      ...(cwd === undefined ? {} : { cwd }),
    });
    const call = (
      h: ReturnType<typeof harness>,
      dispatchPrefix: string | null,
      cwd?: unknown,
      toolCallId = "child-call",
    ) =>
      h.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: {
          agent: "executor",
          task: `${dispatchPrefix}Task`,
          schema: JSON.parse(JSON.stringify(WorkerReportSchema)),
          ...(cwd === undefined ? {} : { cwd }),
        },
      });

    it("normalizes accepted cwd and rejects missing directories", async () => {
      const { h, root, sibling } = cwdHarness();
      const token = await h.invoke();
      expect(
        h.accept(token, {
          assignments: [assignment("a", ["src"], "missing")],
        }),
      ).rejects.toThrow("does not exist");
      // Parent cwd scopes would bypass overlap checks against workspace scopes.
      for (const parent of ["..", root, "/"]) {
        expect(
          h.accept(token, {
            assignments: [assignment("a", ["workspace/src"], parent)],
          }),
        ).rejects.toThrow("must not contain the workspace");
      }
      const accepted = await h.accept(token, {
        assignments: [
          assignment("a", ["src"], "packages/x/"),
          assignment("b", ["src"], join(root, "sibling")),
          assignment("c", ["src"], "."),
        ],
      });
      expect(accepted.ledger.assignments.map((item) => item.cwd)).toEqual([
        "packages/x",
        sibling,
        undefined,
      ]);
    });

    it("detects overlaps through cwd and allows disjoint directories", async () => {
      const { h, root } = cwdHarness();
      const token = await h.invoke();
      await h.accept(token, {
        assignments: [
          assignment("a", ["src"], "packages/x"),
          assignment("b", ["packages/x/src"]),
          assignment("c", ["lib/a"], join(root, "sibling")),
          assignment("d", ["a"], join(root, "sibling/lib")),
          assignment("e", ["src"], join(root, "sibling")),
        ],
      });
      const start = (assignmentId: string) =>
        h.checkpoint(token, { action: "start", assignmentId });
      await start("a");
      expect(start("b")).rejects.toThrow("Active write scopes overlap");
      await start("c");
      expect(start("d")).rejects.toThrow("Active write scopes overlap");
      await start("e");
    });

    it("binds dispatch to the accepted cwd and keeps it across repairs", async () => {
      const { h } = cwdHarness();
      const token = await h.invoke();
      await h.accept(token, {
        assignments: [assignment("a", ["src"], "packages/x")],
      });
      const started = await h.checkpoint(token, {
        action: "start",
        assignmentId: "a",
      });
      for (const wrong of [undefined, ".", "packages", 42]) {
        expect(await call(h, started.dispatchPrefix, wrong)).toMatchObject({
          block: true,
        });
      }
      expect(
        await call(h, started.dispatchPrefix, "packages/x"),
      ).toBeUndefined();
      // A missing report blocks the assignment.
      await h.childResult("child-call", null);
      const repaired = await h.checkpoint(token, {
        action: "repair",
        assignmentId: "a",
        newAssignmentId: "a2",
        task: "Retry A",
      });
      expect(repaired.ledger.assignments[1]?.cwd).toBe("packages/x");
    });

    it("requires user approval for an outside cwd", async () => {
      const { h, root, prompts, state, sibling } = cwdHarness();
      const token = await h.invoke();
      await h.accept(token, {
        assignments: [assignment("a", ["src"], join(root, "sibling"))],
      });
      const started = await h.checkpoint(token, {
        action: "start",
        assignmentId: "a",
      });
      const outside = join(root, "sibling");
      // No UI: outside dispatch cannot be approved.
      expect(await call(h, started.dispatchPrefix, outside)).toMatchObject({
        block: true,
        reason: expect.stringContaining("requires interactive approval"),
      });
      Object.assign(h.ctx, { hasUI: true });
      expect(await call(h, started.dispatchPrefix)).toMatchObject({
        block: true,
        reason: expect.stringContaining("must match"),
      });
      expect(prompts).toEqual([]);
      expect(await call(h, started.dispatchPrefix, outside)).toMatchObject({
        block: true,
        reason: expect.stringContaining("declined"),
      });
      state.answer = true;
      expect(await call(h, started.dispatchPrefix, outside)).toBeUndefined();
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain(sibling);
      await h.childResult("child-call");
      expect(
        (await h.checkpoint(token, { action: "inspect" })).ledger.assignments[0]
          ?.report,
      ).toEqual(report);
    });

    it("revalidates after approval when the ledger changes during the prompt", async () => {
      for (const change of ["stop", "block"] as const) {
        const { h, root } = cwdHarness();
        Object.assign(h.ctx, { hasUI: true });
        const token = await h.invoke();
        await h.accept(token, {
          assignments: [assignment("a", ["src"], join(root, "sibling"))],
        });
        const started = await h.checkpoint(token, {
          action: "start",
          assignmentId: "a",
        });
        Object.assign(h.ctx.ui, {
          confirm: async () => {
            await h.checkpoint(
              token,
              change === "stop"
                ? { action: "stop" }
                : { action: "block", assignmentId: "a", blockers: ["Halt"] },
            );
            return true;
          },
        });
        expect(
          await call(h, started.dispatchPrefix, join(root, "sibling")),
        ).toMatchObject({ block: true });
        const last = h.branch.at(-1) as {
          data: { assignments: Array<{ status: string; toolCallId: unknown }> };
        };
        expect(last.data.assignments[0]).toMatchObject({
          status: "blocked",
          toolCallId: null,
        });
      }
    });

    it("does not prompt for a cwd inside the workspace", async () => {
      const { h, prompts } = cwdHarness();
      Object.assign(h.ctx, { hasUI: true });
      const token = await h.invoke();
      await h.accept(token, {
        assignments: [assignment("a", ["src"], "packages/x")],
      });
      const started = await h.checkpoint(token, {
        action: "start",
        assignmentId: "a",
      });
      expect(
        await call(h, started.dispatchPrefix, "packages/x"),
      ).toBeUndefined();
      expect(prompts).toEqual([]);
    });
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

describe("Spec-drafted marker", () => {
  function markers(branch: unknown[]) {
    return branch.filter(
      (entry) =>
        (entry as { customType?: string }).customType ===
        SPEC_DRAFTED_ENTRY_TYPE,
    );
  }

  it("records successful write and edit results targeting a Spec", async () => {
    const h = harness();
    for (const [toolName, path] of [
      ["write", ".pi/specs/goal.md"],
      ["edit", "@.pi/specs/goal-2.md"],
      ["write", "/workspace/.pi/specs/goal-3.md"],
      ["edit", "./src/../.pi/specs/goal-4.md"],
    ]) {
      await h.emit("tool_result", {
        toolName,
        toolCallId: "call",
        input: { path },
        isError: false,
      });
    }
    expect(markers(h.branch)).toEqual(
      ["goal", "goal-2", "goal-3", "goal-4"].map((slug) => ({
        type: "custom",
        customType: SPEC_DRAFTED_ENTRY_TYPE,
        data: { slug },
      })),
    );
  });

  it("ignores failed results, other tools, invalid slugs, logs and outside paths", async () => {
    const h = harness();
    for (const [toolName, path, isError] of [
      ["write", ".pi/specs/goal.md", true],
      ["read", ".pi/specs/goal.md", false],
      ["write", ".pi/specs/Bad_Slug.md", false],
      ["write", `.pi/specs/${"a".repeat(49)}.md`, false],
      ["write", ".pi/specs/goal.log.jsonl", false],
      ["write", ".pi/specs/nested/goal.md", false],
      ["edit", "other/.pi/specs/goal.md", false],
      ["edit", "/elsewhere/.pi/specs/goal.md", false],
      ["edit", "../.pi/specs/goal.md", false],
      ["write", undefined, false],
    ] as const) {
      await h.emit("tool_result", {
        toolName,
        toolCallId: "call",
        input: { path },
        isError,
      });
    }
    expect(markers(h.branch)).toEqual([]);
  });
});
