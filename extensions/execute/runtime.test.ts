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
  type SpecReviewReport,
  SpecReviewReportSchema,
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
  const sent: unknown[] = [];
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
    sendMessage: (message: unknown) => {
      sent.push(message);
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
        {
          id: "a",
          task: "Implement A",
          scope: ["src/a.ts"],
          dependencies: [],
          ...(extra.specPath ? { criteria: ["DC-1"] } : {}),
        },
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
  // Pi appends a custom message sent during a tool call only at turn end.
  let flushed = 0;
  function endTurn() {
    for (const message of sent.slice(flushed)) {
      const { customType, content } = message as {
        customType: string;
        content: unknown;
      };
      branch.push({ type: "custom_message", customType, content });
    }
    flushed = sent.length;
  }
  return {
    getAbortCount: () => abortCount,
    tools,
    ctx,
    endTurn,
    hooks,
    branch,
    messages,
    sent,
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

const proof = [{ id: "DC-1", evidence: "DC-1 checked" }];
function spec(body: string, criteria = "- DC-1: Works (US-1)") {
  return `# Execution Brief\n${body}\n\n## Done Criteria\n${criteria}\n`;
}

function specHarness(git = false) {
  const cwd = mkdtempSync(join(tmpdir(), "execute-spec-"));
  temporaryWorkspaces.push(cwd);
  mkdirSync(join(cwd, ".pi/specs"), { recursive: true });
  const specPath = ".pi/specs/test.md";
  const logPath = join(cwd, ".pi/specs/test.log.jsonl");
  const content = spec("Canonical plan");
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
    ...(started.ledger.specPath ? { criteria: proof } : {}),
  });
}

function seedVerified(h: ReturnType<typeof specHarness>) {
  appendSpecEvents(h.logPath, [
    {
      event: "accepted",
      ts: new Date().toISOString(),
      hash: hashSpec(h.content),
      invocationId: "old",
      criteria: ["DC-1"],
      assignments: [{ id: "a", dependencies: [], criteria: ["DC-1"] }],
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
      criteria: [{ id: "DC-1", evidence: "Old DC-1 check" }],
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
        {
          id: "a",
          task: "A",
          scope: ["src/a.ts"],
          dependencies: [],
          criteria: ["DC-1"],
        },
        {
          id: "b",
          task: "B",
          scope: ["src/b.ts"],
          dependencies: ["a"],
          criteria: ["DC-1"],
        },
      ],
    });
    expect(readSpecLog(h.logPath)).toEqual([
      {
        event: "accepted",
        ts: expect.any(String),
        hash: hashSpec(h.content),
        invocationId: token,
        criteria: ["DC-1"],
        assignments: [
          { id: "a", dependencies: [], criteria: ["DC-1"] },
          { id: "b", dependencies: ["a"], criteria: ["DC-1"] },
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
      criteria: proof,
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
      criteria: proof,
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

  it("rejects Specs without valid Done Criteria and uncovered or undeclared criteria at accept", async () => {
    for (const [content, extra, error] of [
      [spec("Plan", "- Unlabeled"), {}, "lacks a DC-n: label"],
      [spec("Plan", "- DC-1: A\n- DC-1: B"), {}, "Repeated Done Criterion"],
      [spec("Plan", ""), {}, "has no rows"],
      ["# Execution Brief\nPlan", {}, "no ## Done Criteria section"],
      [
        spec("Plan", "- DC-1: A\n- DC-2: B"),
        {},
        "Done Criterion not declared by any assignment: DC-2",
      ],
      [
        spec("Plan"),
        {
          assignments: [
            {
              id: "a",
              task: "A",
              scope: ["src/a.ts"],
              dependencies: [],
              criteria: ["DC-7"],
            },
          ],
        },
        "Unknown Done Criterion: DC-7",
      ],
      [
        spec("Plan"),
        {
          assignments: [
            { id: "a", task: "A", scope: ["src/a.ts"], dependencies: [] },
          ],
        },
        "Spec-backed assignment requires criteria",
      ],
    ] as const) {
      const h = specHarness();
      writeFileSync(join(h.ctx.cwd, h.specPath), content);
      const token = await h.invoke();
      expect(
        h.accept(token, { specPath: h.specPath, ...extra }),
      ).rejects.toThrow(error);
      expect(h.branch).toEqual([]);
      expect(existsSync(h.logPath)).toBe(false);
    }
    const h = specHarness();
    const token = await h.invoke();
    expect(
      h.accept(token, {
        assignments: [
          {
            id: "a",
            task: "A",
            scope: ["src/a.ts"],
            dependencies: [],
            criteria: ["DC-1"],
          },
        ],
      }),
    ).rejects.toThrow("Assignment criteria require a Spec with Done Criteria");
    expect(h.branch).toEqual([]);
  });

  it("requires structured criteria on verify and reverify", async () => {
    const h = specHarness();
    const token = await h.invoke();
    await h.accept(token, { specPath: h.specPath });
    const { started } = await h.dispatch(token);
    await h.childResult();
    const verify = {
      action: "verify",
      assignmentId: "a",
      attemptId: started.ledger.assignments[0]?.attemptId,
      passed: true,
      evidence: ["Main checked"],
      blockers: [],
    };
    expect(h.checkpoint(token, verify)).rejects.toThrow(
      "Passing verification requires evidence for each declared criterion",
    );
    await h.checkpoint(token, { ...verify, criteria: proof });
    const resuming = harness([], h.ctx.cwd);
    const next = await resuming.invoke();
    await resuming.accept(next, { specPath: h.specPath });
    const { attemptId: _attemptId, ...reverify } = verify;
    expect(resuming.checkpoint(next, reverify)).rejects.toThrow(
      "Passing verification requires evidence for each declared criterion",
    );
    await resuming.checkpoint(next, { ...reverify, criteria: proof });
    expect(readSpecLog(h.logPath).slice(-2)).toMatchObject([
      { event: "verified", resumed: true, criteria: proof },
      { event: "done" },
    ]);
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
    writeFileSync(join(h.ctx.cwd, h.specPath), spec("Changed Spec"));
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
      hash: hashSpec(spec("Changed Spec")),
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
    const b = {
      id: "b",
      task: "B",
      scope: ["src/b.ts"],
      dependencies: [],
      criteria: ["DC-1"],
    };
    const first = await h.invoke();
    await h.accept(first, {
      specPath: h.specPath,
      assignments: [
        {
          id: "a",
          task: "A",
          scope: ["src/a.ts"],
          dependencies: [],
          criteria: ["DC-1"],
        },
        b,
      ],
    });
    await verifyA(h, first);
    writeFileSync(join(h.ctx.cwd, h.specPath), spec("Revised Spec without A"));
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
      criteria: proof,
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
        ...(mode === "stop" ? (["stopped"] as const) : []),
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

  describe("Spec review trigger and gate", () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    afterEach(() => {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    });
    const many = Array.from(
      { length: 8 },
      (_, index) => `- DC-${index + 1}: c${index + 1}`,
    ).join("\n");
    const allCriteria = Array.from(
      { length: 8 },
      (_, index) => `DC-${index + 1}`,
    );
    function reviewHarness({
      consent = false,
      probability = 0,
      content = spec("Canonical plan"),
      hasUI = true,
      models = [{ provider: "typesafe", id: "jev-latest" }] as unknown[],
      fail = false,
    } = {}) {
      const h = specHarness();
      const agentDir = mkdtempSync(join(tmpdir(), "execute-agent-"));
      temporaryWorkspaces.push(agentDir);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      if (consent) {
        mkdirSync(join(agentDir, "spec-review"), { mode: 0o700 });
        writeFileSync(
          join(agentDir, "spec-review/config.json"),
          JSON.stringify({ enabled: true }),
          { mode: 0o600 },
        );
      }
      writeFileSync(join(h.ctx.cwd, h.specPath), content);
      const classified: unknown[] = [];
      Object.assign(h.ctx, {
        hasUI,
        modelRegistry: {
          getAvailableOfType: () => Promise.resolve(models),
          classify: (...args: unknown[]) => {
            classified.push(args);
            return fail
              ? Promise.reject(new Error("down"))
              : Promise.resolve({
                  stopReason: "stop",
                  answers: { change: { type: "bool", probability } },
                });
          },
        },
      });
      const accept = (token: string, ids = ["DC-1"]) =>
        h.accept(token, {
          specPath: h.specPath,
          assignments: [
            {
              id: "a",
              task: "A",
              scope: ["src/a.ts"],
              dependencies: [],
              criteria: ids,
            },
          ],
        });
      return { ...h, classified, content, acceptSpec: accept };
    }
    const required =
      "Spec review required before accept: call execute_checkpoint review for .pi/specs/test.md";

    it("calls the classifier once per hash with consent and gates at probability 0.5", async () => {
      const h = reviewHarness({ consent: true, probability: 0.5 });
      const token = await h.invoke();
      expect(h.acceptSpec(token)).rejects.toThrow(required);
      expect(h.acceptSpec(token)).rejects.toThrow(required);
      expect(h.classified).toHaveLength(1);
      expect(h.branch).toEqual([]);
      expect(existsSync(h.logPath)).toBe(false);

      const low = reviewHarness({ consent: true, probability: 0.49 });
      const next = await low.invoke();
      await low.acceptSpec(next);
      expect(low.classified).toHaveLength(1);
      expect(readSpecLog(low.logPath).map((event) => event.event)).toEqual([
        "accepted",
      ]);
    });

    it("uses the >= 8 Done Criteria fallback without consent, on classifier error or without a model", async () => {
      for (const options of [
        { consent: false, probability: 1 },
        { consent: true, fail: true },
        { consent: true, probability: 1, models: [] },
      ]) {
        const small = reviewHarness(options);
        const token = await small.invoke();
        await small.acceptSpec(token);
        const big = reviewHarness({ ...options, content: spec("Plan", many) });
        const next = await big.invoke();
        expect(big.acceptSpec(next, allCriteria)).rejects.toThrow(required);
        expect(big.branch).toEqual([]);
        expect(big.classified).toHaveLength(options.fail ? 1 : 0);
      }
    });

    it("needs an interactive session and accepts only after approval for the current hash", async () => {
      const h = reviewHarness({
        hasUI: false,
        content: spec("Plan", many),
      });
      const token = await h.invoke();
      expect(h.acceptSpec(token, allCriteria)).rejects.toThrow(
        "Spec review required; it needs an interactive session",
      );
      const reviewed = {
        event: "reviewed" as const,
        ts: new Date().toISOString(),
        round: 1,
        trigger: {
          source: "fallback" as const,
          dcCount: 8,
          reason: "no consent",
        },
        answers: [],
        findings: 0,
      };
      appendSpecEvents(h.logPath, [
        { ...reviewed, hash: "b".repeat(64), decision: "accept" },
        { ...reviewed, hash: hashSpec(h.content), decision: "revise" },
      ]);
      Object.assign(h.ctx, { hasUI: true });
      expect(h.acceptSpec(token, allCriteria)).rejects.toThrow(
        'Spec review recorded "revise" for this Spec hash',
      );
      appendSpecEvents(h.logPath, [
        { ...reviewed, hash: hashSpec(h.content), decision: "accept" },
      ]);
      await h.acceptSpec(token, allCriteria);
      expect(readSpecLog(h.logPath).map((event) => event.event)).toEqual([
        "reviewed",
        "reviewed",
        "reviewed",
        "accepted",
      ]);
      // Resume of an accepted hash skips the trigger entirely.
      const resumed = reviewHarness({
        hasUI: false,
        content: spec("Plan", many),
      });
      appendSpecEvents(resumed.logPath, readSpecLog(h.logPath));
      const again = await resumed.invoke();
      await resumed.acceptSpec(again, allCriteria);
    });

    it("refuses accept after a recorded stop or revise even when the trigger says not required", async () => {
      for (const decision of ["stop", "revise"] as const) {
        const h = reviewHarness({ consent: true, probability: 0 });
        appendSpecEvents(h.logPath, [
          {
            event: "reviewed",
            ts: new Date().toISOString(),
            hash: hashSpec(h.content),
            round: 1,
            trigger: { source: "classifier", probability: 0.9, model: "x/y" },
            decision,
            answers: [],
            findings: 0,
          },
        ]);
        const before = readFileSync(h.logPath, "utf8");
        const token = await h.invoke();
        expect(h.acceptSpec(token)).rejects.toThrow(
          `Spec review recorded "${decision}" for this Spec hash; revise the Spec (a new hash) before accept`,
        );
        expect(h.classified).toHaveLength(0);
        expect(h.branch).toEqual([]);
        expect(readFileSync(h.logPath, "utf8")).toBe(before);
      }
      const ok = reviewHarness({ consent: true, probability: 0 });
      appendSpecEvents(ok.logPath, [
        {
          event: "reviewed",
          ts: new Date().toISOString(),
          hash: hashSpec(ok.content),
          round: 1,
          trigger: { source: "classifier", probability: 0.9, model: "x/y" },
          decision: "accept",
          answers: [],
          findings: 0,
        },
      ]);
      await ok.acceptSpec(await ok.invoke());
      expect(readSpecLog(ok.logPath).map((event) => event.event)).toEqual([
        "reviewed",
        "accepted",
      ]);
    });

    it("still gates a third reviewed hash that requires review", async () => {
      const h = reviewHarness({ content: spec("Plan", many) });
      appendSpecEvents(
        h.logPath,
        ["b", "c"].map((char, index) => ({
          event: "reviewed" as const,
          ts: new Date().toISOString(),
          hash: char.repeat(64),
          round: index + 1,
          trigger: {
            source: "fallback" as const,
            dcCount: 8,
            reason: "no consent",
          },
          decision: "accept" as const,
          answers: [],
          findings: 0,
        })),
      );
      const token = await h.invoke();
      expect(h.acceptSpec(token, allCriteria)).rejects.toThrow(required);
    });

    describe("Spec review round", () => {
      const focus = ["Plan risks and sequencing", "Done Criteria testability"];
      const reports: SpecReviewReport[] = [
        {
          findings: [
            {
              id: "f1",
              severity: "high",
              target: "Plan",
              why: "Plan step 2 races step 3",
              change: "Order step 2 before step 3",
            },
            {
              id: "f2",
              severity: "low",
              target: "Scope",
              why: "Scope omits docs",
              change: "Name the README",
            },
          ],
          questions: [
            { id: "q1", question: "Split DC-3?", options: ["Keep", "Split"] },
          ],
        },
        {
          findings: [
            {
              id: "f3",
              severity: "medium",
              target: "DC-2",
              why: "DC-2 is not testable",
              change: "State the observable result",
            },
          ],
          questions: [
            {
              id: "q2",
              question: "Which test level?",
              options: ["Unit", "Runtime", "End-to-end"],
            },
          ],
        },
      ];
      const reviewSchema = () =>
        JSON.parse(JSON.stringify(SpecReviewReportSchema)) as unknown;
      const reviewedEvent = (
        hash: string,
        round: number,
        content?: string,
      ) => ({
        event: "reviewed" as const,
        ts: new Date().toISOString(),
        hash,
        round,
        trigger: {
          source: "fallback" as const,
          dcCount: 8,
          reason: "no consent",
        },
        decision: "revise" as const,
        answers: [],
        findings: 2,
        ...(content === undefined ? {} : { content }),
      });
      function roundHarness(options: Parameters<typeof reviewHarness>[0] = {}) {
        const h = reviewHarness({ content: spec("Plan", many), ...options });
        const prompts: Array<{ title: string; options: string[] }> = [];
        const answers: Array<string | undefined> = [];
        Object.assign(h.ctx.ui, {
          select: (title: string, choices: string[]) => {
            prompts.push({ title, options: choices });
            return Promise.resolve(answers.shift());
          },
        });
        const review = (token: string) =>
          h.checkpoint(token, {
            action: "review",
            specPath: h.specPath,
            focus,
          });
        const resolveStep = (token: string) =>
          h.checkpoint(token, {
            action: "resolve_review",
            specPath: h.specPath,
          });
        // Present, let Pi append the message at turn end, then ask.
        const resolveReview = async (token: string) => {
          const first = await resolveStep(token);
          if (!first.review?.presented) {
            return first;
          }
          h.endTurn();
          return resolveStep(token);
        };
        const reviewer = (
          prefix: string,
          callId: string,
          index = 0,
          input: Record<string, unknown> = {},
        ) =>
          h.emit("tool_call", {
            toolName: "subagent",
            toolCallId: callId,
            input: {
              agent: "spec-reviewer",
              task: `${prefix}Focus: ${focus[index]}\nOther reviewer focus: ${focus[1 - index]}\nReview ${h.specPath}`,
              schema: reviewSchema(),
              ...input,
            },
          });
        return {
          ...h,
          prompts,
          answers,
          review,
          resolveStep,
          resolveReview,
          reviewer,
        };
      }
      async function reviewedRound(
        h: ReturnType<typeof roundHarness>,
        outputs: readonly unknown[] = reports,
      ) {
        const token = await h.invoke();
        const { dispatchPrefix } = await h.review(token);
        if (!dispatchPrefix) {
          throw new Error("Missing review prefix");
        }
        expect(await h.reviewer(dispatchPrefix, "r1", 0)).toBeUndefined();
        expect(await h.reviewer(dispatchPrefix, "r2", 1)).toBeUndefined();
        await h.childResult("r1", {
          runId: "run1",
          structuredOutput: outputs[0],
        });
        await h.childResult("r2", {
          runId: "run2",
          structuredOutput: outputs[1],
        });
        return { token, dispatchPrefix };
      }

      it("rejects focus statements with edge whitespace before starting a round", async () => {
        const h = roundHarness();
        const token = await h.invoke();
        for (const edge of [` ${focus[0]}`, `${focus[0]} `]) {
          expect(
            h.checkpoint(token, {
              action: "review",
              specPath: h.specPath,
              focus: [edge, focus[1]],
            }),
          ).rejects.toThrow("Invalid");
        }
        expect(h.resolveReview(token)).rejects.toThrow(
          "No live Spec review round",
        );
        const prefix = (await h.review(token)).dispatchPrefix ?? "";
        expect(await h.reviewer(prefix, "r1", 0)).toBeUndefined();
        expect(await h.reviewer(prefix, "r2", 1)).toBeUndefined();
      });

      it("binds exactly two reviewers, resolves through the user and then passes accept", async () => {
        const h = roundHarness();
        const token = await h.invoke();
        expect(h.acceptSpec(token, allCriteria)).rejects.toThrow(required);
        expect(h.resolveReview(token)).rejects.toThrow(
          "No live Spec review round",
        );
        const started = await h.review(token);
        const prefix = started.dispatchPrefix ?? "";
        expect(prefix).toMatch(
          new RegExp(`^Spec review binding: ${token}/test/[0-9a-f-]{36}\\n$`),
        );
        expect(started.ledger.assignments).toEqual([]);
        expect(h.branch).toEqual([]);
        expect(h.review(token)).rejects.toThrow("already started");
        expect(h.resolveReview(token)).rejects.toThrow(focus[0]);

        for (const [input, reason] of [
          [{ agent: "executor" }, "spec-reviewer"],
          [
            { schema: JSON.parse(JSON.stringify(WorkerReportSchema)) },
            "SpecReviewReportSchema",
          ],
          [{ cwd: "." }, "cwd"],
          [{ task: `${prefix}Focus: Something else` }, "Unknown"],
          [{ task: `${prefix}${focus[0]}` }, "exactly one"],
          [
            { task: `${prefix}Focus: ${focus[0]}\nFocus: ${focus[1]}` },
            "exactly one",
          ],
          [
            {
              task: `Spec review binding: ${token}/test/stale\nFocus: ${focus[0]}`,
            },
            "stale",
          ],
        ] as const) {
          expect(await h.reviewer(prefix, "bad", 0, input)).toEqual({
            block: true,
            reason: expect.stringContaining(reason),
          });
        }
        expect(await h.reviewer(prefix, "r1", 0)).toBeUndefined();
        expect(await h.reviewer(prefix, "dup", 0)).toEqual({
          block: true,
          reason: expect.stringContaining("already bound"),
        });
        expect(await h.reviewer(prefix, "r2", 1)).toBeUndefined();
        expect(await h.reviewer(prefix, "r3", 1)).toEqual({
          block: true,
          reason: expect.stringContaining("two reviewer calls"),
        });
        expect(h.resolveReview(token)).rejects.toThrow("missing");
        await h.childResult("r1", {
          runId: "run1",
          structuredOutput: reports[0],
        });
        await h.childResult("r2", {
          runId: "run2",
          structuredOutput: reports[1],
        });
        expect(h.branch).toEqual([]);

        h.answers.push("Split", "Runtime", "Accept as reviewed");
        const resolved = await h.resolveReview(token);
        expect(h.prompts.map(({ options }) => options)).toEqual([
          ["Keep", "Split", "Type something."],
          ["Unit", "Runtime", "End-to-end", "Type something."],
          ["Accept as reviewed", "Revise"],
        ]);
        expect(h.prompts[0]?.title).toBe("Split DC-3?");
        expect(h.prompts[2]?.title).toBe(
          `Spec review of ${h.specPath}: ${reports[0].findings.length + reports[1].findings.length} findings. Accept as reviewed or revise?`,
        );
        for (const finding of [
          ...reports[0].findings,
          ...reports[1].findings,
        ]) {
          expect(JSON.stringify(h.sent)).toContain(finding.why);
          expect(JSON.stringify(h.sent)).toContain(finding.change);
        }
        expect(h.sent).toEqual([
          expect.objectContaining({ customType: "spec-review", display: true }),
        ]);
        const answers = [
          {
            id: "0:q1",
            focus: focus[0],
            question: "Split DC-3?",
            answer: "Split",
          },
          {
            id: "1:q2",
            focus: focus[1],
            question: "Which test level?",
            answer: "Runtime",
          },
        ];
        expect(resolved.dispatchPrefix).toBeNull();
        expect(resolved).toMatchObject({
          review: {
            round: 1,
            decision: "accept",
            answers,
            findings: [...reports[0].findings, ...reports[1].findings],
          },
        });
        expect(readSpecLog(h.logPath)).toEqual([
          {
            event: "reviewed",
            ts: expect.any(String),
            hash: hashSpec(h.content),
            round: 1,
            trigger: { source: "fallback", dcCount: 8, reason: "no consent" },
            decision: "accept",
            answers,
            findings: 3,
            content: h.content,
          },
        ]);
        expect(h.resolveReview(token)).rejects.toThrow(
          "No live Spec review round",
        );
        expect(await h.reviewer(prefix, "late", 0)).toEqual({
          block: true,
          reason: expect.stringContaining("stale"),
        });
        await h.acceptSpec(token, allCriteria);
        expect(readSpecLog(h.logPath).map((event) => event.event)).toEqual([
          "reviewed",
          "accepted",
        ]);
        expect(h.review(token)).rejects.toThrow("already accepted");
      });

      it("needs UI, a required review and an unreviewed hash", async () => {
        const headless = roundHarness({ hasUI: false });
        const token = await headless.invoke();
        expect(headless.review(token)).rejects.toThrow("interactive session");
        expect(headless.resolveReview(token)).rejects.toThrow(
          "interactive session",
        );
        const small = roundHarness({ content: spec("Plan") });
        const next = await small.invoke();
        expect(small.review(next)).rejects.toThrow("not required");
        const other = await small.invoke();
        expect(
          small.checkpoint(other, {
            action: "review",
            specPath: ".pi/specs/missing.md",
            focus,
          }),
        ).rejects.toThrow("Spec not found");
        expect(
          small.checkpoint("unauthorized", {
            action: "review",
            specPath: small.specPath,
            focus,
          }),
        ).rejects.toThrow("Unauthorized");
      });

      it("records nothing on cancel and records the user's revise choice", async () => {
        const h = roundHarness();
        const { token } = await reviewedRound(h);
        h.answers.push("Keep", undefined);
        expect(h.resolveReview(token)).rejects.toThrow("cancelled");
        await Bun.sleep(0);
        expect(existsSync(h.logPath)).toBe(false);
        h.answers.push("Keep", "Unit", "Revise");
        expect((await h.resolveReview(token)).review?.decision).toBe("revise");
        expect(readSpecLog(h.logPath)).toMatchObject([
          {
            event: "reviewed",
            decision: "revise",
            answers: [
              {
                id: "0:q1",
                focus: focus[0],
                question: "Split DC-3?",
                answer: "Keep",
              },
              {
                id: "1:q2",
                focus: focus[1],
                question: "Which test level?",
                answer: "Unit",
              },
            ],
          },
        ]);
        expect(h.acceptSpec(token, allCriteria)).rejects.toThrow(
          'Spec review recorded "revise" for this Spec hash',
        );
        expect(h.review(token)).rejects.toThrow("already reviewed");
      });

      it("scopes answers by reviewer slot when both reports reuse a question id", async () => {
        const h = roundHarness();
        const { token } = await reviewedRound(h, [
          reports[0],
          {
            ...reports[1],
            questions: [{ ...reports[1].questions[0], id: "q1" }],
          },
        ]);
        h.answers.push("Split", "Runtime", "Accept as reviewed");
        const answers = [
          {
            id: "0:q1",
            focus: focus[0],
            question: "Split DC-3?",
            answer: "Split",
          },
          {
            id: "1:q1",
            focus: focus[1],
            question: "Which test level?",
            answer: "Runtime",
          },
        ];
        expect((await h.resolveReview(token)).review?.answers).toEqual(answers);
        expect(readSpecLog(h.logPath)).toMatchObject([
          { event: "reviewed", answers },
        ]);
      });

      it("captures reports only from run-bound structuredOutput and allows one retry per focus", async () => {
        const h = roundHarness();
        const token = await h.invoke();
        const prefix = (await h.review(token)).dispatchPrefix ?? "";
        expect(await h.reviewer(prefix, "r1", 0)).toBeUndefined();
        await h.childResult("r1", { runId: "run1", output: "prose" });
        expect(await h.reviewer(prefix, "r2", 0)).toBeUndefined();
        await h.childResult("r2", {
          runId: "run2",
          structuredOutput: { findings: [{ target: "Other" }], questions: [] },
        });
        expect(await h.reviewer(prefix, "r3", 0)).toEqual({
          block: true,
          reason: expect.stringContaining("retry"),
        });
        expect(await h.reviewer(prefix, "r4", 1)).toBeUndefined();
        await h.emit("tool_execution_end", {
          toolName: "subagent",
          toolCallId: "r4",
          isError: true,
        });
        expect(await h.reviewer(prefix, "r5", 1)).toBeUndefined();
        expect(h.resolveReview(token)).rejects.toThrow(focus[0]);
        expect(h.notifications.length).toBeGreaterThan(0);
        expect(h.branch).toEqual([]);

        // Reload clears the live round.
        await h.emit("session_start");
        const fresh = await h.invoke();
        expect(await h.reviewer(prefix, "r6", 1)).toEqual({
          block: true,
          reason: expect.stringContaining("stale"),
        });
        expect(h.resolveReview(fresh)).rejects.toThrow(
          "No live Spec review round",
        );
      });

      it("after two reviewed hashes offers only Accept as is or Stop without children", async () => {
        for (const [choice, decision] of [
          ["Stop", "stop"],
          ["Accept as is", "accept"],
        ] as const) {
          const h = roundHarness();
          appendSpecEvents(
            h.logPath,
            ["b", "c"].map((char, index) => ({
              event: "reviewed" as const,
              ts: new Date().toISOString(),
              hash: char.repeat(64),
              round: index + 1,
              trigger: {
                source: "fallback" as const,
                dcCount: 8,
                reason: "no consent",
              },
              decision: "revise" as const,
              answers: [],
              findings: 2,
            })),
          );
          const token = await h.invoke();
          const started = await h.review(token);
          expect(started.dispatchPrefix).toBeNull();
          expect(JSON.stringify(started)).toContain("round limit");
          h.answers.push(choice);
          const resolved = await h.resolveReview(token);
          expect(h.prompts.map(({ options }) => options)).toEqual([
            ["Accept as is", "Stop"],
          ]);
          expect(resolved).toMatchObject({
            review: { round: 3, decision, answers: [], findings: [] },
          });
          expect(readSpecLog(h.logPath).at(-1)).toMatchObject({
            event: "reviewed",
            hash: hashSpec(h.content),
            round: 3,
            decision,
            answers: [],
            findings: 0,
          });
          if (decision === "stop") {
            expect(h.acceptSpec(token, allCriteria)).rejects.toThrow(
              'Spec review recorded "stop" for this Spec hash',
            );
          } else {
            await h.acceptSpec(token, allCriteria);
          }
        }
      });

      it("shows the revision diff since the last reviewed copy before the limit gate", async () => {
        const h = roundHarness();
        const previous = spec("Old plan", many);
        appendSpecEvents(h.logPath, [
          reviewedEvent("b".repeat(64), 1),
          reviewedEvent(hashSpec(previous), 2, previous),
        ]);
        const token = await h.invoke();
        await h.review(token);
        h.answers.push("Accept as is");
        await h.resolveReview(token);
        expect(h.sent).toEqual([
          expect.objectContaining({ customType: "spec-review", display: true }),
        ]);
        const shown = JSON.stringify(h.sent);
        expect(shown).toContain("Spec revision since review round 2");
        expect(shown).toContain("-Old plan");
        expect(shown).toContain("+Plan");
        expect(h.prompts[0]?.title).toBe(
          `Spec review round limit reached for ${h.specPath}. Accept as is or stop?`,
        );
        expect(readSpecLog(h.logPath).at(-1)).toMatchObject({
          round: 3,
          content: h.content,
        });
      });

      it("fences the revision diff so Spec code fences in hunk context cannot close it", async () => {
        const block = "```ts\nconst x = 1;\n```";
        const h = roundHarness({ content: spec(`${block}\nNew plan`, many) });
        const previous = spec(`${block}\nOld plan`, many);
        appendSpecEvents(h.logPath, [
          reviewedEvent("b".repeat(64), 1),
          reviewedEvent(hashSpec(previous), 2, previous),
        ]);
        const token = await h.invoke();
        await h.review(token);
        h.answers.push("Accept as is");
        await h.resolveReview(token);
        const text = (h.sent[0] as { content: string }).content;
        expect(text).toContain("-Old plan");
        expect(text).toContain(" ```");
        const lines = text.split("\n");
        const opening = lines.findIndex((line) => /^`{3,}diff$/.test(line));
        const fence = lines[opening]?.slice(0, -"diff".length) ?? "";
        expect(fence.length).toBeGreaterThanOrEqual(4);
        expect(lines.at(-1)).toBe(fence);
        const closer = new RegExp(`^ {0,3}\`{${fence.length},}\\s*$`);
        expect(
          lines.slice(opening + 1, -1).filter((line) => closer.test(line)),
        ).toEqual([]);
      });

      function tuiDriver(h: ReturnType<typeof roundHarness>) {
        // Drives the shared ask dialog: renders it, then feeds the next
        // `scripts` keys. Each screen is captured after every key.
        const screens: string[][] = [];
        const scripts: string[][] = [];
        const theme = {
          bold: (s: string) => s,
          fg: (_t: string, s: string) => s,
          bg: (_t: string, s: string) => s,
        };
        let customCalls = 0;
        Object.assign(h.ctx, { mode: "tui" });
        Object.assign(h.ctx.ui, {
          custom: (
            factory: (
              tui: unknown,
              theme: unknown,
              kb: unknown,
              done: (value: unknown) => void,
            ) => {
              render(width: number): string[];
              handleInput(data: string): void;
            },
          ) =>
            new Promise((resolve) => {
              customCalls++;
              const tui = {
                requestRender: () => undefined,
                terminal: { rows: 60 },
              };
              let settled = false;
              const component = factory(tui, theme, undefined, (value) => {
                settled = true;
                resolve(value);
              });
              const shots = [component.render(100).join("\n")];
              for (const key of scripts.shift() ?? ["\u001b"]) {
                if (settled) {
                  break;
                }
                component.handleInput(key);
                shots.push(component.render(100).join("\n"));
              }
              screens.push(shots);
            }),
          select: () => {
            throw new Error("TUI path must not use ui.select");
          },
          input: () => {
            throw new Error("TUI path must not use ui.input");
          },
        });
        return { screens, scripts, customCalls: () => customCalls };
      }

      it("presents the review text in one call and asks only in the next", async () => {
        const h = roundHarness();
        const { customCalls } = tuiDriver(h);
        const { token } = await reviewedRound(h);
        const first = await h.resolveStep(token);
        expect(first.review).toMatchObject({ presented: true, round: 1 });
        expect(customCalls()).toBe(0);
        expect(h.sent).toEqual([
          expect.objectContaining({ customType: "spec-review", display: true }),
        ]);
        expect(readSpecLog(h.logPath)).toEqual([]);
        // Before Pi appends the message, asking is refused.
        expect(h.resolveStep(token)).rejects.toThrow("not in the transcript");
        expect(customCalls()).toBe(0);
        h.endTurn();
        expect(h.resolveStep(token)).rejects.toThrow("Spec review cancelled");
        await Bun.sleep(0);
        expect(customCalls()).toBe(1);
        // Still one message: a retry after cancel does not resend it.
        expect(h.sent).toHaveLength(1);
      });

      it("TUI asks every question and the gate in the shared ask dialog and accepts a typed answer", async () => {
        const h = roundHarness();
        const { screens, scripts, customCalls } = tuiDriver(h);
        const { token } = await reviewedRound(h);
        // Q1: move to "Type something.", open the field, type, submit.
        // Q2: pick "Runtime". Decision: pick "Accept as reviewed".
        // Then confirm on the ask Submit tab.
        scripts.push([
          "\u001b[B",
          "\u001b[B",
          "\r",
          ..."Merge DC-3".split(""),
          "\r",
          "\u001b[B",
          "\r",
          "\r",
          "\r",
        ]);
        const resolved = await h.resolveReview(token);
        expect(customCalls()).toBe(1);
        expect(h.prompts).toEqual([]);
        const shots = screens[0] ?? [];
        const first = shots[0] ?? "";
        // The ask tab bar names every question, then the Submit tab.
        expect(first).toContain("Q1");
        expect(first).toContain("Decision");
        expect(first).toContain("Split DC-3?");
        expect(first).toContain("Type something.");
        // The review text lives in the transcript, not in the dialog.
        expect(first).not.toContain("Plan step 2 races step 3");
        const gate = shots.find((shot) => shot.includes("Accept as reviewed"));
        expect(gate).toBeDefined();
        expect(gate).not.toContain("Type something.");
        expect(resolved).toMatchObject({
          review: {
            decision: "accept",
            answers: [
              { id: "0:q1", answer: "Merge DC-3" },
              { id: "1:q2", answer: "Runtime" },
            ],
          },
        });
      });

      it("TUI limit gate is a single ask question after the revision diff message", async () => {
        const h = roundHarness();
        const { screens, scripts } = tuiDriver(h);
        const previous = spec("Old plan", many);
        appendSpecEvents(h.logPath, [
          reviewedEvent("b".repeat(64), 1),
          reviewedEvent(hashSpec(previous), 2, previous),
        ]);
        const token = await h.invoke();
        await h.review(token);
        scripts.push(["\u001b[B", "\r"]);
        const resolved = await h.resolveReview(token);
        const shown = JSON.stringify(h.branch);
        expect(shown).toContain("Spec revision since review round 2");
        expect(shown).toContain("-Old plan");
        const gate = screens[0]?.[0] ?? "";
        expect(gate).toContain("Accept as is");
        expect(gate).not.toContain("Type something.");
        expect(resolved).toMatchObject({ review: { decision: "stop" } });
      });

      it("TUI cancel records nothing", async () => {
        const h = roundHarness();
        tuiDriver(h);
        const { token } = await reviewedRound(h);
        expect(h.resolveReview(token)).rejects.toThrow("Spec review cancelled");
        await Bun.sleep(0);
        expect(readSpecLog(h.logPath)).toEqual([]);
      });

      it("without TUI a typed reviewer answer goes through ui.input", async () => {
        const h = roundHarness();
        const inputs: string[] = [];
        Object.assign(h.ctx.ui, {
          input: (title: string) => {
            inputs.push(title);
            return Promise.resolve("  Merge DC-3 ");
          },
        });
        const { token } = await reviewedRound(h);
        h.answers.push("Type something.", "Runtime", "Accept as reviewed");
        const resolved = await h.resolveReview(token);
        expect(inputs).toEqual(["Split DC-3?"]);
        expect(resolved).toMatchObject({
          review: {
            answers: [
              { id: "0:q1", answer: "Merge DC-3" },
              { id: "1:q2", answer: "Runtime" },
            ],
          },
        });
      });

      it("says so when the last reviewed copy predates stored content", async () => {
        const h = roundHarness();
        appendSpecEvents(h.logPath, [
          reviewedEvent("b".repeat(64), 1),
          reviewedEvent("c".repeat(64), 2),
        ]);
        const token = await h.invoke();
        await h.review(token);
        h.answers.push("Stop");
        await h.resolveReview(token);
        expect(JSON.stringify(h.sent)).toContain(
          "changed since review round 2; no reviewed copy is stored",
        );
      });
    });
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
        action: "accept",
        plan: "Plan",
        approval: "Safe local work",
        specPath: ".pi/specs/test.md",
        assignments: [
          {
            id: "a",
            task: "Task",
            scope: ["src/a.ts"],
            dependencies: [],
            criteria: ["DC-1"],
          },
        ],
      },
      {
        invocationId,
        action: "verify",
        assignmentId: "a",
        passed: true,
        evidence: ["Main checked"],
        blockers: [],
        criteria: [{ id: "DC-1", evidence: "DC-1 checked" }],
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
      {
        invocationId,
        action: "review",
        specPath: ".pi/specs/test.md",
        focus: ["Plan risks", "Done Criteria proof"],
      },
      { invocationId, action: "resolve_review", specPath: ".pi/specs/test.md" },
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
      ...[
        ["One"],
        ["One", "One"],
        ["One", "Two", "Three"],
        ["One", ""],
        [" One", "Two"],
        ["One", "Two "],
      ].map((focus) => ({
        invocationId,
        action: "review",
        specPath: ".pi/specs/test.md",
        focus,
      })),
      { invocationId, action: "review", focus: ["One", "Two"] },
      {
        invocationId,
        action: "resolve_review",
        specPath: ".pi/specs/test.md",
        focus: ["One", "Two"],
      },
      {
        invocationId,
        action: "block",
        assignmentId: "a",
        blockers: ["Blocked"],
        criteria: [{ id: "DC-1", evidence: "x" }],
      },
      {
        invocationId,
        action: "verify",
        assignmentId: "a",
        passed: true,
        evidence: ["Main checked"],
        blockers: [],
        criteria: [{ id: "US-1", evidence: "x" }],
      },
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
      const signals: unknown[] = [];
      const state = { answer: false };
      Object.assign(h.ctx.ui, {
        confirm: async (
          _title: string,
          message: string,
          options?: { signal?: AbortSignal },
        ) => {
          prompts.push(message);
          signals.push(options?.signal);
          return !options?.signal?.aborted && state.answer;
        },
      });
      const sibling = realpathSync(join(root, "sibling"));
      return { h, root, cwd, prompts, signals, state, sibling };
    }
    // Approve outside cwds at accept, as the accepting invocation would.
    function approvedHarness() {
      const harnessed = cwdHarness();
      Object.assign(harnessed.h.ctx, { hasUI: true });
      harnessed.state.answer = true;
      return harnessed;
    }
    // Reload drops in-memory approval; a new invocation continues the ledger.
    async function continueInvocation(h: ReturnType<typeof harness>) {
      await h.emit("session_start");
      return h.invoke();
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
      const { h, root, sibling } = approvedHarness();
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
      const { h, root } = approvedHarness();
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

    it("asks once at accept for every distinct outside cwd", async () => {
      const { h, root, cwd, prompts, signals, sibling } = approvedHarness();
      const signal = new AbortController().signal;
      Object.assign(h.ctx, { signal });
      const token = await h.invoke();
      await h.accept(token, {
        assignments: [
          assignment("a", ["x"], join(root, "sibling")),
          assignment("b", ["y"], `${join(root, "sibling")}/`),
          assignment("c", ["z"], join(root, "sibling/lib")),
          assignment("d", ["src"], "packages/x"),
          assignment("e", ["lib"]),
        ],
      });
      expect(prompts).toHaveLength(1);
      expect(signals).toEqual([signal]);
      const lines = prompts[0]?.split("\n") ?? [];
      expect(lines.filter((line) => line === sibling)).toHaveLength(1);
      expect(lines).toContain(join(sibling, "lib"));
      expect(lines).toContain(cwd);
      expect(prompts[0]).not.toContain("packages/x");
    });

    it("rejects accept without approval and persists nothing", async () => {
      for (const mode of ["no-ui", "decline", "abort"] as const) {
        const { h, root, cwd, prompts, state } = cwdHarness();
        mkdirSync(join(cwd, ".pi/specs"), { recursive: true });
        writeFileSync(join(cwd, ".pi/specs/test.md"), spec("Plan"));
        if (mode !== "no-ui") {
          Object.assign(h.ctx, { hasUI: true });
        }
        if (mode === "abort") {
          const controller = new AbortController();
          controller.abort();
          Object.assign(h.ctx, { signal: controller.signal });
          state.answer = true;
        }
        const token = await h.invoke();
        const rejected = await h
          .accept(token, {
            specPath: ".pi/specs/test.md",
            assignments: [
              {
                ...assignment("a", ["src"], join(root, "sibling")),
                criteria: ["DC-1"],
              },
            ],
          })
          .then(
            () => "accepted",
            (error: unknown) =>
              error instanceof Error ? error.message : "non-error rejection",
          );
        expect(rejected).toContain(
          mode === "no-ui" ? "requires interactive approval" : "not approved",
        );
        expect(prompts).toHaveLength(mode === "no-ui" ? 0 : 1);
        expect(h.branch).toEqual([]);
        expect(existsSync(join(cwd, ".pi/specs/test.log.jsonl"))).toBe(false);
        expect(
          (await h.checkpoint(token, { action: "inspect" })).ledger.plan,
        ).toBeNull();
      }
    });

    it("rejects accept when authorization is revoked during the prompt", async () => {
      const { h, root } = approvedHarness();
      const token = await h.invoke();
      Object.assign(h.ctx.ui, {
        confirm: async () => {
          await h.emit("session_start");
          return true;
        },
      });
      const rejected = await h
        .accept(token, {
          assignments: [assignment("a", ["src"], join(root, "sibling"))],
        })
        .then(
          () => "accepted",
          (error: unknown) =>
            error instanceof Error ? error.message : "non-error rejection",
        );
      expect(rejected).toContain("Unauthorized");
      expect(h.branch).toEqual([]);
    });

    it("opens no dialog for parallel dispatches approved at accept", async () => {
      const { h, root, prompts } = approvedHarness();
      const token = await h.invoke();
      const cwds = {
        a: join(root, "sibling"),
        b: join(root, "sibling"),
        c: join(root, "sibling/lib"),
      };
      await h.accept(token, {
        assignments: Object.entries(cwds).map(([id, cwd]) =>
          assignment(id, [id], cwd),
        ),
      });
      expect(prompts).toHaveLength(1);
      const results = await Promise.all(
        Object.entries(cwds).map(async ([assignmentId, cwd]) => {
          const started = await h.checkpoint(token, {
            action: "start",
            assignmentId,
          });
          return call(h, started.dispatchPrefix, cwd, `call-${assignmentId}`);
        }),
      );
      expect(results).toEqual([undefined, undefined, undefined]);
      expect(prompts).toHaveLength(1);
    });

    it("confirms once per cwd for a continuing invocation, sharing concurrent prompts", async () => {
      const { h, root, prompts, sibling } = approvedHarness();
      const cwds = {
        a: join(root, "sibling"),
        b: join(root, "sibling"),
        c: join(root, "sibling/lib"),
        d: join(root, "sibling"),
      };
      await h.accept(await h.invoke(), {
        assignments: Object.entries(cwds).map(([id, cwd]) =>
          assignment(id, [id], cwd),
        ),
      });
      const token = await continueInvocation(h);
      const answers: Array<(value: boolean) => void> = [];
      Object.assign(h.ctx.ui, {
        confirm: (_title: string, message: string) => {
          prompts.push(message);
          return new Promise<boolean>((resolve) => answers.push(resolve));
        },
      });
      const prefixes: Record<string, string | null> = {};
      for (const assignmentId of Object.keys(cwds)) {
        prefixes[assignmentId] = (
          await h.checkpoint(token, { action: "start", assignmentId })
        ).dispatchPrefix;
      }
      const dispatch = (assignmentId: "a" | "b" | "c" | "d") =>
        call(
          h,
          prefixes[assignmentId] ?? null,
          cwds[assignmentId],
          `call-${assignmentId}`,
        );
      const pending = Promise.all([
        dispatch("a"),
        dispatch("b"),
        dispatch("c"),
      ]);
      await Bun.sleep(0);
      expect(prompts.slice(1)).toHaveLength(2);
      expect(prompts[1]).toContain(sibling);
      expect(prompts[2]).toContain(join(sibling, "lib"));
      for (const answer of answers) {
        answer(true);
      }
      expect(await pending).toEqual([undefined, undefined, undefined]);
      expect(await dispatch("d")).toBeUndefined();
      expect(prompts).toHaveLength(3);
    });

    it("blocks fallback dispatch without UI or when declined", async () => {
      const { h, root, prompts, state, sibling } = approvedHarness();
      await h.accept(await h.invoke(), {
        assignments: [assignment("a", ["src"], join(root, "sibling"))],
      });
      const token = await continueInvocation(h);
      const started = await h.checkpoint(token, {
        action: "start",
        assignmentId: "a",
      });
      const outside = join(root, "sibling");
      Object.assign(h.ctx, { hasUI: false });
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
      expect(prompts).toHaveLength(1);
      state.answer = false;
      expect(await call(h, started.dispatchPrefix, outside)).toMatchObject({
        block: true,
        reason: expect.stringContaining("declined"),
      });
      state.answer = true;
      expect(await call(h, started.dispatchPrefix, outside)).toBeUndefined();
      expect(prompts).toHaveLength(3);
      expect(prompts[2]).toContain(sibling);
      await h.childResult("child-call");
      expect(
        (await h.checkpoint(token, { action: "inspect" })).ledger.assignments[0]
          ?.report,
      ).toEqual(report);
    });

    it("revalidates after approval when the ledger changes during the prompt", async () => {
      for (const change of ["stop", "block"] as const) {
        const { h, root } = approvedHarness();
        await h.accept(await h.invoke(), {
          assignments: [assignment("a", ["src"], join(root, "sibling"))],
        });
        const token = await continueInvocation(h);
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
      const token = await h.invoke();
      // Without UI too: in-workspace plans need no approval.
      await h.accept(token, {
        assignments: [
          assignment("a", ["src"], "packages/x"),
          assignment("b", ["lib"]),
        ],
      });
      Object.assign(h.ctx, { hasUI: true });
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
