import { describe, expect, it } from "bun:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  bindCall,
  emptyLedger,
  LEDGER_ENTRY_TYPE,
  recordReport,
  restoreLedger,
  transitionLedger,
} from "./ledger";
import type { ExecutionLedger } from "./schema";

const invocationId = "invocation";
const roots = [
  { id: "a", task: "Implement A", scope: ["src/a"], dependencies: [] },
  { id: "b", task: "Implement B", scope: ["src/b"], dependencies: ["a"] },
];
const report = {
  status: "done",
  summary: "Implemented",
  filesTouched: ["src/a/file.ts"],
  validation: ["bun test: passed"],
  blockers: [],
  followUps: [],
};
function step(
  state: ExecutionLedger,
  input: Record<string, unknown>,
  attemptId = "attempt-a",
) {
  return transitionLedger(state, { invocationId, ...input }, attemptId);
}
function accepted(assignments = roots) {
  return step(emptyLedger("session", invocationId), {
    action: "accept",
    plan: "Canonical brief",
    approval: "Safe local changes; danger preflight passed",
    assignments,
  });
}
function reported(
  state = accepted(),
  assignmentId = "a",
  attemptId = "attempt-a",
  runId = "run-a",
) {
  const started = step(state, { action: "start", assignmentId }, attemptId);
  const bound = bindCall(started, assignmentId, attemptId, `call-${attemptId}`);
  return recordReport(
    bound,
    assignmentId,
    attemptId,
    `call-${attemptId}`,
    runId,
    report,
  );
}
function verified(
  state = reported(),
  assignmentId = "a",
  attemptId = "attempt-a",
  passed = true,
) {
  return step(state, {
    action: "verify",
    assignmentId,
    attemptId,
    passed,
    evidence: ["Main inspected diff; bun test: exit 0"],
    blockers: passed ? [] : ["Current test failure"],
  });
}

describe("execution ledger", () => {
  it("reconstructs the selected branch of an actual native Pi SessionManager", () => {
    const session = SessionManager.inMemory("/workspace");
    const sessionId = session.getSessionId();
    const plan = { ...accepted(), sessionId };
    const planEntry = session.appendCustomEntry(LEDGER_ENTRY_TYPE, plan);
    session.appendCustomEntry(LEDGER_ENTRY_TYPE, { ...verified(), sessionId });
    session.branch(planEntry);
    session.appendCustomEntry("unrelated-extension", { ignored: true });
    expect(session.getEntries().length).toBe(3);
    expect(session.getBranch().length).toBe(2);
    expect(restoreLedger(session.getBranch(), sessionId)).toEqual(plan);
  });
  it("rejects persisted active-state inconsistencies and shared repair successors", () => {
    const base = accepted([roots[0], { ...roots[1], dependencies: [] }]);
    const [a, b] = base.assignments;
    const entry = (data: unknown) => ({
      type: "custom",
      customType: LEDGER_ENTRY_TYPE,
      data,
    });
    const runningA = { ...a, status: "running", attemptId: "attempt-a" };
    const runningB = { ...b, status: "running", attemptId: "attempt-b" };
    const cases = [
      {
        ...base,
        assignments: [{ ...runningA, dependencies: ["b"] }, runningB],
      },
      {
        ...base,
        assignments: [runningA, { ...runningB, scope: ["src/a/sub"] }],
      },
      { ...base, assignments: [] },
      {
        ...base,
        assignments: [
          {
            ...a,
            status: "blocked",
            blockers: ["failure"],
            supersededBy: "fix",
          },
          {
            ...b,
            status: "blocked",
            blockers: ["failure"],
            supersededBy: "fix",
          },
          { ...a, id: "fix", lineageId: "a", repairCount: 1 },
        ],
      },
    ];
    for (const invalid of cases) {
      expect(() => restoreLedger([entry(invalid)], "session")).toThrow();
    }
  });

  it("preserves counts across branch reload and does not charge read-only re-verification", () => {
    let state = verified(reported(), "a", "attempt-a", false);
    state = verified(state);
    expect(state.assignments[0]?.repairCount).toBe(0);
    let failed = verified(reported(), "a", "attempt-a", false);
    failed = step(failed, {
      action: "repair",
      assignmentId: "a",
      newAssignmentId: "fix",
      task: "Repair",
    });
    const reload = restoreLedger(
      [{ type: "custom", customType: LEDGER_ENTRY_TYPE, data: failed }],
      "session",
    );
    expect(reload?.assignments.at(-1)?.repairCount).toBe(1);
  });

  it("replaces latest verification evidence after 100 failures, including second-repair lineage", () => {
    const session = SessionManager.inMemory("/workspace");
    let state = { ...reported(), sessionId: session.getSessionId() };
    const failedEvidence = Array.from(
      { length: 100 },
      (_, index) => `Failure evidence ${index}`,
    );
    const fail = (
      current: ExecutionLedger,
      assignmentId: string,
      attemptId: string,
    ) =>
      step(current, {
        action: "verify",
        assignmentId,
        attemptId,
        passed: false,
        evidence: failedEvidence,
        blockers: ["Main found a failure"],
      });
    state = fail(state, "a", "attempt-a");
    const snapshot = session.appendCustomEntry(LEDGER_ENTRY_TYPE, state);
    const complete = verified(state);
    session.appendCustomEntry(LEDGER_ENTRY_TYPE, complete);
    expect(complete.assignments[0]?.status).toBe("completed");
    expect(complete.assignments[0]?.evidence).toEqual([
      "Main inspected diff; bun test: exit 0",
    ]);
    expect(state.assignments[0]?.evidence).toEqual(failedEvidence);
    const historical = session.getEntry(snapshot);
    expect(historical?.type === "custom" && historical.data).toEqual(state);

    for (let count = 1; count <= 2; count++) {
      const previousId = count === 1 ? "a" : "fix-1";
      state = step(state, {
        action: "repair",
        assignmentId: previousId,
        newAssignmentId: `fix-${count}`,
        task: "Scoped repair",
      });
      state = reported(
        state,
        `fix-${count}`,
        `attempt-fix-${count}`,
        `run-fix-${count}`,
      );
      state = fail(state, `fix-${count}`, `attempt-fix-${count}`);
    }
    state = verified(state, "fix-2", "attempt-fix-2");
    expect(state.assignments.at(-1)?.status).toBe("completed");
    expect(state.assignments.at(-1)?.evidence).toEqual([
      "Main inspected diff; bun test: exit 0",
    ]);
    expect(state.assignments.at(-1)?.repairCount).toBe(2);
    expect(state.assignments.at(-1)?.lineageId).toBe("a");
    expect(
      step(state, { action: "start", assignmentId: "b" }, "attempt-b")
        .assignments[1]?.status,
    ).toBe("running");
  });

  it("bounds active assignments and rejects replayed runner identities", () => {
    let state = accepted(
      Array.from({ length: 5 }, (_, index) => ({
        id: `task-${index}`,
        task: "Work",
        scope: [`src/${index}`],
        dependencies: [],
      })),
    );
    for (let index = 0; index < 4; index++) {
      state = step(
        state,
        { action: "start", assignmentId: `task-${index}` },
        `attempt-${index}`,
      );
    }
    expect(() =>
      step(state, { action: "start", assignmentId: "task-4" }, "attempt-4"),
    ).toThrow("four");
    const first = accepted([roots[0], { ...roots[1], dependencies: [] }]);
    const done = verified(reported(first));
    const next = bindCall(
      step(done, { action: "start", assignmentId: "b" }, "attempt-b"),
      "b",
      "attempt-b",
      "call-b",
    );
    expect(() =>
      recordReport(next, "b", "attempt-b", "call-b", "run-a", report),
    ).toThrow("Duplicate runId");
  });

  it("requires main verification before completing or dispatching dependencies", () => {
    const state = reported();
    expect(state.assignments[0]?.status).toBe("running");
    expect(() => step(state, { action: "start", assignmentId: "b" })).toThrow(
      "verified",
    );
    const complete = verified(state);
    expect(complete.assignments[0]?.status).toBe("completed");
    expect(
      step(complete, { action: "start", assignmentId: "b" }, "attempt-b")
        .assignments[1]?.status,
    ).toBe("running");
    expect(state.assignments[0]?.evidence).toEqual([]);
  });

  it("rejects duplicate IDs, unknown dependencies, duplicate edges and cycles", () => {
    for (const assignments of [
      [roots[0], roots[0]],
      [{ ...roots[0], dependencies: ["missing"] }],
      [{ ...roots[0], dependencies: ["b", "b"] }, roots[1]],
      [{ ...roots[0], dependencies: ["b"] }, roots[1]],
    ]) {
      expect(() => accepted(assignments)).toThrow();
    }
  });

  it("rejects unsafe scopes and overlapping active assignments", () => {
    for (const scope of [
      ["../outside"],
      ["/absolute"],
      ["src/**"],
      ["src/../outside"],
      ["src\\a"],
    ]) {
      expect(() => accepted([{ ...roots[0], scope }])).toThrow("scope");
    }
    const state = accepted([
      roots[0],
      { ...roots[1], dependencies: [], scope: ["src/a/sub"] },
    ]);
    expect(() =>
      step(
        step(state, { action: "start", assignmentId: "a" }),
        { action: "start", assignmentId: "b" },
        "attempt-b",
      ),
    ).toThrow("overlap");
  });

  it("limits repairs across new IDs, preserving dependency gating and lineage", () => {
    let state = verified(reported(), "a", "attempt-a", false);
    state = step(state, {
      action: "repair",
      assignmentId: "a",
      newAssignmentId: "a-fix-1",
      task: "Repair A",
    });
    expect(() =>
      step(state, { action: "start", assignmentId: "b" }, "attempt-b"),
    ).toThrow("verified");
    state = verified(
      reported(state, "a-fix-1", "fix-1", "run-fix-1"),
      "a-fix-1",
      "fix-1",
      false,
    );
    state = step(state, {
      action: "repair",
      assignmentId: "a-fix-1",
      newAssignmentId: "a-fix-2",
      task: "Repair A again",
    });
    state = verified(
      reported(state, "a-fix-2", "fix-2", "run-fix-2"),
      "a-fix-2",
      "fix-2",
      false,
    );
    expect(state.assignments.at(-1)?.repairCount).toBe(2);
    expect(state.assignments.at(-1)?.lineageId).toBe("a");
    expect(() =>
      step(state, {
        action: "repair",
        assignmentId: "a-fix-2",
        newAssignmentId: "new-id",
        task: "Try again",
      }),
    ).toThrow("budget");
    expect(() =>
      step(state, {
        action: "accept",
        plan: "Reset",
        approval: "Safe",
        assignments: roots,
      }),
    ).toThrow("accepted");
  });

  it("unblocks the original dependency only after a repair is verified", () => {
    let state = verified(reported(), "a", "attempt-a", false);
    state = step(state, {
      action: "repair",
      assignmentId: "a",
      newAssignmentId: "fix",
      task: "Repair A",
    });
    state = verified(
      reported(state, "fix", "fix-attempt", "run-fix"),
      "fix",
      "fix-attempt",
    );
    expect(
      step(state, { action: "start", assignmentId: "b" }, "attempt-b")
        .assignments[1]?.status,
    ).toBe("running");
  });

  it("keeps explicit blockers and rejects reports without evidence of a bound call", () => {
    const state = step(accepted(), { action: "start", assignmentId: "a" });
    expect(() =>
      recordReport(state, "a", "attempt-a", "unknown", "run", report),
    ).toThrow("bound");
    const bound = bindCall(state, "a", "attempt-a", "call");
    for (const invalid of [
      null,
      { ...report, unexpected: true },
      { ...report, status: "needs_followup" },
      { ...report, status: "blocked" },
      { ...report, blockers: ["missing"], status: "done" },
    ]) {
      expect(() =>
        recordReport(bound, "a", "attempt-a", "call", "run", invalid),
      ).toThrow();
    }
    const blocked = recordReport(bound, "a", "attempt-a", "call", "run", {
      ...report,
      status: "blocked",
      blockers: ["Missing prerequisite"],
    });
    expect(blocked.assignments[0]?.status).toBe("blocked");
    expect(() => verified(blocked)).toThrow();
  });

  it("rejects stale attempts, duplicate report replay and stale invocations", () => {
    const state = reported();
    expect(() =>
      recordReport(
        state,
        "a",
        "old-attempt",
        "call-attempt-a",
        "run-old",
        report,
      ),
    ).toThrow("Stale");
    expect(() =>
      recordReport(state, "a", "attempt-a", "call-attempt-a", "run-a", report),
    ).toThrow();
    expect(() =>
      transitionLedger(state, { invocationId: "old", action: "inspect" }),
    ).toThrow("authorization");
    expect(() => verified(state, "a", "old-attempt")).toThrow("Stale");
  });

  it("rejects invalid patches and cannot silently reset started or completed assignments", () => {
    const state = reported();
    for (const input of [
      null,
      {},
      { action: "verify", assignmentId: "a", status: "completed" },
      { action: "inspect", extra: true },
      {
        action: "repair",
        assignmentId: "missing",
        newAssignmentId: "x",
        task: "repair",
      },
    ]) {
      expect(() => transitionLedger(state, input)).toThrow();
    }
    expect(() => step(state, { action: "start", assignmentId: "a" })).toThrow();
    expect(() =>
      step(state, {
        action: "verify",
        assignmentId: "a",
        attemptId: "attempt-a",
        passed: true,
        evidence: [],
        blockers: [],
      }),
    ).toThrow();
    expect(() =>
      step(verified(state), {
        action: "block",
        assignmentId: "a",
        blockers: ["reset"],
      }),
    ).toThrow();
  });

  it("restores only supplied branch entries and validates persisted unknown data", () => {
    const first = accepted();
    const second = verified();
    const entry = (data: unknown) => ({
      type: "custom",
      customType: LEDGER_ENTRY_TYPE,
      data,
    });
    expect(
      restoreLedger([entry(first), { type: "message" }], "session"),
    ).toEqual(first);
    expect(restoreLedger([entry(first), entry(second)], "session")).toEqual(
      second,
    );
    expect(restoreLedger([], "session")).toBeNull();
    expect(() => restoreLedger([entry(second)], "another-session")).toThrow(
      "session",
    );
    for (const invalid of [
      { ...first, unknown: true },
      {
        ...first,
        assignments: [{ ...first.assignments[0], status: "completed" }],
      },
      {
        ...first,
        assignments: first.assignments.map((a) => ({ ...a, repairCount: 2 })),
      },
      null,
    ]) {
      expect(() =>
        restoreLedger([entry(first), entry(invalid)], "session"),
      ).toThrow();
    }
  });
});
