import { describe, expect, it } from "bun:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  bindCall,
  emptyLedger,
  isLedgerComplete,
  LEDGER_ENTRY_TYPE,
  recordReport,
  restoreLedger,
  transitionLedger,
  validateLedger,
} from "./ledger";
import type { ExecutionLedger, SpecResume } from "./schema";

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
  resume?: SpecResume,
) {
  return transitionLedger(state, { invocationId, ...input }, attemptId, resume);
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

const specPath = ".pi/specs/example.md";
const specRoots = roots.map((item) => ({ ...item, criteria: ["DC-1"] }));
const proof = [{ id: "DC-1", evidence: "Main read current code" }];
function resumed(
  resume: SpecResume = { verified: ["a"], blocked: {}, priorRepairs: { a: 1 } },
  assignments = specRoots,
  reviseSpec = false,
) {
  return transitionLedger(
    emptyLedger("session", invocationId),
    {
      invocationId,
      action: "accept",
      plan: "Canonical brief",
      approval: "Safe local changes",
      assignments,
      specPath,
      reviseSpec,
    },
    "attempt-a",
    resume,
    ["DC-1"],
  );
}
function reverify(state = resumed(), assignmentId = "a", passed = true) {
  return step(state, {
    action: "verify",
    assignmentId,
    passed,
    evidence: ["Main read current code; bun test: exit 0"],
    blockers: passed ? [] : ["Current workspace differs"],
    ...(passed ? { criteria: proof } : {}),
  });
}
function specAccepted(
  assignments: unknown[] = [
    { ...roots[0], criteria: ["DC-1"] },
    { ...roots[1], criteria: ["DC-1", "DC-2"] },
  ],
  specCriteria = ["DC-1", "DC-2"],
) {
  return transitionLedger(
    emptyLedger("session", invocationId),
    {
      invocationId,
      action: "accept",
      plan: "Canonical brief",
      approval: "Safe",
      specPath,
      assignments,
    },
    "attempt-a",
    undefined,
    specCriteria,
  );
}
function proveA(state: ExecutionLedger, criteria?: unknown, passed = true) {
  return step(reported(state), {
    action: "verify",
    assignmentId: "a",
    attemptId: "attempt-a",
    passed,
    evidence: ["Main inspected diff"],
    blockers: passed ? [] : ["Current test failure"],
    ...(criteria === undefined ? {} : { criteria }),
  });
}

describe("Done Criterion gate", () => {
  it("stores Spec Done Criteria and assignment criteria at accept", () => {
    const state = specAccepted();
    expect(state.specCriteria).toEqual(["DC-1", "DC-2"]);
    expect(state.assignments.map((item) => item.criteria)).toEqual([
      ["DC-1"],
      ["DC-1", "DC-2"],
    ]);
    expect(accepted().specCriteria).toBeUndefined();
    expect(accepted().assignments[0]?.criteria).toBeUndefined();
  });

  it("rejects missing, unknown, duplicate and uncovered criteria at Spec-backed accept", () => {
    expect(() => specAccepted(roots)).toThrow(
      "Spec-backed assignment requires criteria",
    );
    expect(() =>
      specAccepted([{ ...roots[0], criteria: [] }, specRoots[1]]),
    ).toThrow("Invalid execute_checkpoint input");
    expect(() =>
      specAccepted([{ ...roots[0], criteria: ["DC-9"] }, specRoots[1]]),
    ).toThrow("Unknown Done Criterion: DC-9");
    expect(() =>
      specAccepted([{ ...roots[0], criteria: ["DC-1", "DC-1"] }, specRoots[1]]),
    ).toThrow("Duplicate assignment criteria");
    expect(() => specAccepted(specRoots)).toThrow(
      "Done Criterion not declared by any assignment: DC-2",
    );
    expect(() =>
      transitionLedger(emptyLedger("session", invocationId), {
        invocationId,
        action: "accept",
        plan: "Canonical brief",
        approval: "Safe",
        specPath,
        assignments: specRoots,
      }),
    ).toThrow("Spec-backed accept requires parsed Done Criteria");
  });

  it("rejects criteria on inline-plan accept", () => {
    expect(() => accepted(specRoots)).toThrow(
      "Assignment criteria require a Spec with Done Criteria",
    );
  });

  it("requires exactly one evidence entry per declared criterion on passing verify", () => {
    const state = specAccepted();
    expect(() => proveA(state)).toThrow(
      "Passing verification requires evidence for each declared criterion",
    );
    for (const criteria of [
      [{ id: "DC-2", evidence: "Wrong" }],
      [
        { id: "DC-1", evidence: "One" },
        { id: "DC-1", evidence: "Two" },
      ],
      [
        { id: "DC-1", evidence: "One" },
        { id: "DC-2", evidence: "Extra" },
      ],
    ]) {
      expect(() => proveA(state, criteria)).toThrow(
        "Passing verification requires evidence for each declared criterion",
      );
    }
    expect(() => proveA(state, [{ id: "DC-1", evidence: "" }])).toThrow(
      "Invalid execute_checkpoint input",
    );
    const passed = proveA(state, [{ id: "DC-1", evidence: "DC-1 test" }]);
    expect(passed.assignments[0]).toMatchObject({
      status: "completed",
      criteriaEvidence: [{ id: "DC-1", evidence: "DC-1 test" }],
    });
    const failed = proveA(state, undefined, false);
    expect(failed.assignments[0]).toMatchObject({
      status: "blocked",
      criteriaEvidence: [],
    });
  });

  it("rejects criteria evidence on inline-plan verify", () => {
    expect(() =>
      proveA(accepted(), [{ id: "DC-1", evidence: "Inline" }]),
    ).toThrow("Verification criteria require Spec-backed assignment criteria");
  });

  it("completes only when every declaring assignment proved its criteria", () => {
    const state = proveA(specAccepted(), [{ id: "DC-1", evidence: "A" }]);
    expect(isLedgerComplete(state)).toBe(false);
    const complete = step(
      reported(state, "b", "attempt-b", "run-b"),
      {
        action: "verify",
        assignmentId: "b",
        attemptId: "attempt-b",
        passed: true,
        evidence: ["Main inspected B"],
        blockers: [],
        criteria: [
          { id: "DC-2", evidence: "B proves DC-2" },
          { id: "DC-1", evidence: "B proves DC-1" },
        ],
      },
      "attempt-b",
    );
    expect(isLedgerComplete(complete)).toBe(true);
    for (const criteriaEvidence of [undefined, [], [proof[0]]]) {
      expect(() =>
        validateLedger({
          ...complete,
          assignments: complete.assignments.map((item) =>
            item.id === "b" ? { ...item, criteriaEvidence } : item,
          ),
        }),
      ).toThrow("Completion requires evidence for each declared criterion");
    }
  });

  it("inherits criteria on repair and rejects changed repair criteria", () => {
    const failed = proveA(specAccepted(), undefined, false);
    const repaired = step(failed, {
      action: "repair",
      assignmentId: "a",
      newAssignmentId: "fix",
      task: "Fix A",
    });
    expect(repaired.assignments.at(-1)?.criteria).toEqual(["DC-1"]);
    expect(() =>
      validateLedger({
        ...repaired,
        assignments: repaired.assignments.map((item) =>
          item.id === "fix" ? { ...item, criteria: ["DC-2"] } : item,
        ),
      }),
    ).toThrow("Repair changed scope or dependencies");
  });

  it("requires structured criteria again on resumed reverify", () => {
    const state = resumed();
    expect(() =>
      step(state, {
        action: "verify",
        assignmentId: "a",
        passed: true,
        evidence: ["Main read current code"],
        blockers: [],
      }),
    ).toThrow(
      "Passing verification requires evidence for each declared criterion",
    );
    expect(reverify(state).assignments[0]?.criteriaEvidence).toEqual(proof);
  });
});

describe("Spec resume ledger", () => {
  it("stores a Spec path only when supplied and keeps ordinary assignments unchanged", () => {
    expect(emptyLedger("session", invocationId).specPath).toBeNull();
    expect(accepted().specPath).toBeNull();
    const state = specAccepted(specRoots, ["DC-1"]);
    expect(state.specPath).toBe(specPath);
    expect(
      state.assignments.map(
        ({ criteria: _criteria, criteriaEvidence: _evidence, ...item }) => item,
      ),
    ).toEqual(accepted().assignments);
    expect(state.assignments[0]?.priorRepairs).toBeUndefined();
    expect(state.assignments[0]?.resumed).toBeUndefined();
  });

  it("derives reverify and prior repair budgets from runtime resume metadata", () => {
    const state = resumed();
    expect(state.assignments[0]).toMatchObject({
      status: "reverify",
      resumed: true,
      priorRepairs: 1,
      repairCount: 0,
      attemptId: null,
      toolCallId: null,
      runId: null,
      report: null,
      evidence: [],
      blockers: [],
    });
    expect(state.assignments[1]).toMatchObject({
      status: "pending",
      priorRepairs: 0,
    });
    expect(state.assignments[1]?.resumed).toBeUndefined();
    expect(isLedgerComplete(state)).toBe(false);
    expect(() =>
      step(
        emptyLedger("session", invocationId),
        {
          action: "accept",
          plan: "Canonical brief",
          approval: "Safe",
          assignments: roots,
        },
        "attempt-a",
        { verified: ["a"], blocked: {}, priorRepairs: {} },
      ),
    ).toThrow("specPath");
  });

  it("prevents rename resets for verified and repaired lineages unless explicitly revised", () => {
    for (const resume of [
      { verified: ["missing"], blocked: {}, priorRepairs: {} },
      { verified: [], blocked: {}, priorRepairs: { missing: 2 } },
      { verified: [], blocked: {}, priorRepairs: { missing: 0 } },
    ]) {
      expect(() => resumed(resume)).toThrow(
        "Resumed spec lineage missing from accepted plan; revise the spec explicitly",
      );
      expect(resumed(resume, specRoots, true).assignments[0]?.status).toBe(
        "pending",
      );
    }
    expect(
      resumed(
        { verified: ["a"], blocked: {}, priorRepairs: { a: 2 } },
        specRoots,
        true,
      ).assignments[0],
    ).toMatchObject({ status: "reverify", priorRepairs: 2 });
  });

  it("reverifies without a worker claim or attempt, without charging repairs", () => {
    const state = resumed(
      { verified: ["a"], blocked: {}, priorRepairs: { a: 2 } },
      [specRoots[0]],
    );
    const complete = reverify(state);
    expect(complete.assignments[0]).toMatchObject({
      status: "completed",
      resumed: true,
      report: null,
      attemptId: null,
      evidence: ["Main read current code; bun test: exit 0"],
      blockers: [],
      repairCount: 0,
      priorRepairs: 2,
    });
    expect(validateLedger(complete)).toEqual(complete);
    expect(isLedgerComplete(complete)).toBe(true);
    expect(state.assignments[0]?.evidence).toEqual([]);
    const failed = reverify(state, "a", false);
    expect(failed.assignments[0]).toMatchObject({
      status: "blocked",
      report: null,
      blockers: ["Current workspace differs"],
      evidence: ["Main read current code; bun test: exit 0"],
    });
    expect(isLedgerComplete(failed)).toBe(false);
  });

  it("rejects attempt-bound reverify and requires an attempt for normal verification", () => {
    expect(() => verified(resumed())).toThrow(
      "Reverification must not include an attemptId",
    );
    expect(() => reverify(reported())).toThrow(
      "Verification requires the running attemptId",
    );
    for (const passed of [true, false]) {
      expect(() =>
        step(resumed(), {
          action: "verify",
          assignmentId: "a",
          passed,
          evidence: ["Main inspected"],
          blockers: passed ? ["Contradiction"] : [],
        }),
      ).toThrow("outcome and blockers disagree");
    }
  });

  it("keeps reverify read-only and gates dependents on fresh main evidence", () => {
    const state = resumed();
    expect(() => step(state, { action: "start", assignmentId: "a" })).toThrow(
      "Only pending assignments can start",
    );
    expect(() => step(state, { action: "start", assignmentId: "b" })).toThrow(
      "main-verified",
    );
    expect(
      step(reverify(state), { action: "start", assignmentId: "b" }, "attempt-b")
        .assignments[1]?.status,
    ).toBe("running");
    const both = resumed({
      verified: ["a", "b"],
      blocked: {},
      priorRepairs: {},
    });
    expect(() => reverify(both, "b")).toThrow(
      "Dependencies must remain main-verified",
    );
    expect(reverify(reverify(both), "b").assignments[1]?.status).toBe(
      "completed",
    );
    expect(
      step(state, {
        action: "block",
        assignmentId: "a",
        blockers: ["Missing current evidence"],
      }).assignments[0]?.status,
    ).toBe("blocked");
  });

  it("charges carried repair budgets and creates fresh mutation successors", () => {
    const exhausted = reverify(
      resumed({ verified: ["a"], blocked: {}, priorRepairs: { a: 2 } }),
      "a",
      false,
    );
    const repair = {
      action: "repair",
      assignmentId: "a",
      newAssignmentId: "fix",
      task: "Scoped repair",
    };
    expect(() => step(exhausted, repair)).toThrow("budget exhausted");
    const state = step(reverify(resumed(), "a", false), repair);
    expect(state.assignments.at(-1)).toMatchObject({
      lineageId: "a",
      repairCount: 1,
      priorRepairs: 1,
      status: "pending",
    });
    expect(state.assignments.at(-1)?.resumed).toBeUndefined();
    expect(() => reverify(state, "fix")).toThrow(
      "Verification requires the running attemptId",
    );
    const failed = verified(
      reported(state, "fix", "attempt-fix", "run-fix"),
      "fix",
      "attempt-fix",
      false,
    );
    expect(() =>
      step(failed, {
        ...repair,
        assignmentId: "fix",
        newAssignmentId: "fix-2",
      }),
    ).toThrow("budget exhausted");
    expect(() =>
      validateLedger({
        ...state,
        assignments: state.assignments.map((item) => ({
          ...item,
          priorRepairs: 2,
        })),
      }),
    ).toThrow("budget");
    expect(() =>
      validateLedger({
        ...state,
        assignments: state.assignments.map((item) =>
          item.id === "fix" ? { ...item, priorRepairs: 0 } : item,
        ),
      }),
    ).toThrow("prior repairs");
    expect(() =>
      resumed({ verified: [], blocked: {}, priorRepairs: { a: 3 } }),
    ).toThrow();
    expect(() =>
      resumed({ verified: [], blocked: {}, priorRepairs: { a: -1 } }),
    ).toThrow();
  });

  it("restores an exhausted blocked lineage as blocked without new mutations", () => {
    const state = resumed(
      {
        verified: [],
        blocked: { a: ["Logged test failure"] },
        priorRepairs: { a: 2 },
      },
      [specRoots[0]],
    );
    expect(state.assignments[0]).toMatchObject({
      status: "blocked",
      blockers: ["Logged test failure"],
      repairCount: 0,
      priorRepairs: 2,
      attemptId: null,
      report: null,
    });
    expect(validateLedger(state)).toEqual(state);
    expect(() => step(state, { action: "start", assignmentId: "a" })).toThrow(
      "Only pending assignments can start",
    );
    expect(() =>
      step(state, {
        action: "repair",
        assignmentId: "a",
        newAssignmentId: "fix",
        task: "Scoped repair",
      }),
    ).toThrow("budget exhausted");
  });

  it("restores an interrupted lineage as blocked and charges its repairs", () => {
    const interrupted = "Interrupted in a prior session; repair required";
    const state = resumed(
      { verified: [], blocked: { a: [interrupted] }, priorRepairs: {} },
      [specRoots[0]],
    );
    expect(state.assignments[0]).toMatchObject({
      status: "blocked",
      blockers: [interrupted],
      priorRepairs: 0,
    });
    expect(() => step(state, { action: "start", assignmentId: "a" })).toThrow(
      "Only pending assignments can start",
    );
    expect(() =>
      step(state, {
        action: "verify",
        assignmentId: "a",
        passed: true,
        evidence: ["Main inspected"],
        blockers: [],
      }),
    ).toThrow("Verification requires the running attemptId");
    const repair = { action: "repair", task: "Scoped repair" };
    const first = step(state, {
      ...repair,
      assignmentId: "a",
      newAssignmentId: "fix",
    });
    expect(first.assignments.at(-1)).toMatchObject({
      lineageId: "a",
      repairCount: 1,
      priorRepairs: 0,
      status: "pending",
    });
    const failed = verified(
      reported(first, "fix", "attempt-fix", "run-fix"),
      "fix",
      "attempt-fix",
      false,
    );
    const second = step(failed, {
      ...repair,
      assignmentId: "fix",
      newAssignmentId: "fix-2",
    });
    const exhausted = verified(
      reported(second, "fix-2", "attempt-fix-2", "run-fix-2"),
      "fix-2",
      "attempt-fix-2",
      false,
    );
    expect(() =>
      step(exhausted, {
        ...repair,
        assignmentId: "fix-2",
        newAssignmentId: "fix-3",
      }),
    ).toThrow("budget exhausted");
  });

  it("keeps lineages without logged progress pending and startable", () => {
    const state = resumed({ verified: [], blocked: {}, priorRepairs: {} }, [
      specRoots[0],
    ]);
    expect(state.assignments[0]).toMatchObject({
      status: "pending",
      priorRepairs: 0,
      blockers: [],
    });
    expect(
      step(state, { action: "start", assignmentId: "a" }).assignments[0]
        ?.status,
    ).toBe("running");
  });

  it("rejects starting a lineage root that carries spent repair budget", () => {
    for (const priorRepairs of [1, 2]) {
      const state = resumed(
        { verified: [], blocked: {}, priorRepairs: { a: priorRepairs } },
        [specRoots[0]],
      );
      expect(() => step(state, { action: "start", assignmentId: "a" })).toThrow(
        "Resumed lineage has spent repairs; use repair before dispatch",
      );
    }
  });

  it("validates clean reverify state and preserves ordinary completion rules", () => {
    const state = resumed();
    for (const patch of [
      { resumed: false },
      { resumed: undefined },
      { attemptId: "attempt" },
      { toolCallId: "call" },
      { runId: "run" },
      { report },
      { evidence: ["Stale evidence"] },
      { blockers: ["Stale blocker"] },
    ]) {
      expect(() =>
        validateLedger({
          ...state,
          assignments: state.assignments.map((item) =>
            item.id === "a" ? { ...item, ...patch } : item,
          ),
        }),
      ).toThrow();
    }
    const complete = reverify(state);
    for (const patch of [
      { resumed: false },
      { evidence: [] },
      { blockers: ["Unresolved"] },
    ]) {
      expect(() =>
        validateLedger({
          ...complete,
          assignments: complete.assignments.map((item) =>
            item.id === "a" ? { ...item, ...patch } : item,
          ),
        }),
      ).toThrow("Completion requires");
    }
  });

  it("accepts persisted v1 ledgers without the new optional fields", () => {
    const { specPath: _specPath, ...legacy } = verified();
    expect(validateLedger(legacy)).toEqual(legacy);
    expect(
      restoreLedger(
        [{ type: "custom", customType: LEDGER_ENTRY_TYPE, data: legacy }],
        "session",
      ),
    ).toEqual(legacy);
  });
});

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
