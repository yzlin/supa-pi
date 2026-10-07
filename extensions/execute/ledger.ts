import { Value } from "typebox/value";

import {
  type Assignment,
  type AssignmentInput,
  CheckpointSchema,
  type ExecutionLedger,
  LedgerSchema,
  type WorkerReport,
  WorkerReportSchema,
} from "./schema";

export const LEDGER_ENTRY_TYPE = "execute-ledger-v1";
export const MAX_REPAIRS = 2;

export function emptyLedger(
  sessionId: string,
  invocationId: string,
): ExecutionLedger {
  return {
    version: 1,
    sessionId,
    invocationId,
    plan: null,
    approval: null,
    assignments: [],
  };
}

function requireAssignment(state: ExecutionLedger, id: string): Assignment {
  const assignment = state.assignments.find((item) => item.id === id);
  if (!assignment) {
    throw new Error(`Unknown assignment: ${id}`);
  }
  return assignment;
}

function latestAssignment(state: ExecutionLedger, id: string): Assignment {
  const assignment = requireAssignment(state, id);
  return assignment.supersededBy
    ? latestAssignment(state, assignment.supersededBy)
    : assignment;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 32) {
      return true;
    }
  }
  return false;
}

function checkScope(scope: string): void {
  if (scope === ".") {
    return;
  }
  if (
    scope.startsWith("/") ||
    /[\\*?[\]{}:]/.test(scope) ||
    hasControlCharacters(scope) ||
    scope.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      "Assignment scope must be a literal workspace-relative file or directory (no globs)",
    );
  }
}

function scopesOverlap(a: Assignment, b: Assignment): boolean {
  return a.scope.some((left) =>
    b.scope.some(
      (right) =>
        left === "." ||
        right === "." ||
        left === right ||
        left.startsWith(`${right}/`) ||
        right.startsWith(`${left}/`),
    ),
  );
}

function validateGraph(assignments: readonly Assignment[]): void {
  const byId = new Map(assignments.map((item) => [item.id, item]));
  if (byId.size !== assignments.length) {
    throw new Error("Duplicate assignment IDs");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) {
      throw new Error("Assignment graph contains a cycle");
    }
    if (visited.has(id)) {
      return;
    }
    const item = byId.get(id);
    if (!item) {
      throw new Error(`Unknown graph dependency: ${id}`);
    }
    if (new Set(item.dependencies).size !== item.dependencies.length) {
      throw new Error("Duplicate dependency edges");
    }
    visiting.add(id);
    for (const dependency of [
      ...item.dependencies,
      ...(item.supersededBy ? [item.supersededBy] : []),
    ]) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const assignment of assignments) {
    visit(assignment.id);
  }
}

export function validateReport(input: unknown): WorkerReport {
  if (!Value.Check(WorkerReportSchema, input)) {
    throw new Error("Invalid structured worker report");
  }
  if ((input.status === "done") !== (input.blockers.length === 0)) {
    throw new Error("Worker outcome and blockers disagree");
  }
  for (const file of input.filesTouched) {
    checkScope(file);
  }
  return input;
}

export function validateLedger(input: unknown): ExecutionLedger {
  if (!Value.Check(LedgerSchema, input)) {
    throw new Error("Invalid persisted execution ledger");
  }
  validateGraph(input.assignments);
  if (
    (input.plan === null) !== (input.approval === null) ||
    (input.plan === null && input.assignments.length > 0) ||
    (input.plan !== null && input.assignments.length === 0)
  ) {
    throw new Error("Invalid accepted plan");
  }
  for (const item of input.assignments) {
    for (const scope of item.scope) {
      checkScope(scope);
    }
    const root = requireAssignment(input, item.lineageId);
    const predecessor = input.assignments.find(
      (parent) => parent.supersededBy === item.id,
    );
    if (
      item.repairCount === 0
        ? item.id !== item.lineageId || predecessor !== undefined
        : !predecessor ||
          predecessor.lineageId !== item.lineageId ||
          predecessor.repairCount + 1 !== item.repairCount
    ) {
      throw new Error("Invalid repair lineage");
    }
    if (
      root.repairCount !== 0 ||
      JSON.stringify(root.scope) !== JSON.stringify(item.scope) ||
      JSON.stringify(root.dependencies) !== JSON.stringify(item.dependencies)
    ) {
      throw new Error("Repair changed scope or dependencies");
    }
    if (item.supersededBy) {
      const successor = requireAssignment(input, item.supersededBy);
      if (
        item.status !== "blocked" ||
        successor.lineageId !== item.lineageId ||
        successor.repairCount !== item.repairCount + 1
      ) {
        throw new Error("Invalid repair successor or outcome");
      }
    }
    if (
      ["running", "completed"].includes(item.status) &&
      item.dependencies.some(
        (id) => latestAssignment(input, id).status !== "completed",
      )
    ) {
      throw new Error(
        "Active and completed assignments require verified prerequisites",
      );
    }
    if (item.report) {
      validateReport(item.report);
    }
    if (
      item.status === "pending" &&
      (item.attemptId ||
        item.toolCallId ||
        item.runId ||
        item.report ||
        item.evidence.length ||
        item.blockers.length)
    ) {
      throw new Error("Invalid pending assignment");
    }
    if (
      item.status === "running" &&
      (!item.attemptId || item.blockers.length)
    ) {
      throw new Error("Invalid running assignment");
    }
    if (item.status === "blocked" && !item.blockers.length) {
      throw new Error("Blocked assignment needs exact blockers");
    }
    if (
      (item.toolCallId && !item.attemptId) ||
      (item.runId && !item.toolCallId) ||
      (item.report && !item.runId)
    ) {
      throw new Error("Report lacks bound call evidence");
    }
    if (
      item.status === "completed" &&
      (!item.report ||
        item.report.status !== "done" ||
        !item.evidence.length ||
        item.blockers.length)
    ) {
      throw new Error(
        "Completion requires main verification evidence and a done claim",
      );
    }
    if (
      item.report &&
      item.report.status !== "done" &&
      item.status !== "blocked"
    ) {
      throw new Error("Worker blocker cannot be completed");
    }
  }
  const active = input.assignments.filter((item) => item.status === "running");
  if (
    active.length > 4 ||
    active.some((item, index) =>
      active.slice(index + 1).some((other) => scopesOverlap(item, other)),
    )
  ) {
    throw new Error(
      "Invalid active assignment count or overlapping write scopes",
    );
  }
  for (const key of ["attemptId", "toolCallId", "runId"] as const) {
    const values = input.assignments.flatMap((item) =>
      item[key] ? [item[key]] : [],
    );
    if (new Set(values).size !== values.length) {
      throw new Error(`Duplicate ${key} evidence`);
    }
  }
  return input;
}

function replaceAssignment(
  state: ExecutionLedger,
  assignment: Assignment,
): ExecutionLedger {
  const next = {
    ...state,
    assignments: state.assignments.map((item) =>
      item.id === assignment.id ? assignment : item,
    ),
  };
  return validateLedger(next);
}

function makeAssignment(input: AssignmentInput): Assignment {
  return {
    ...structuredClone(input),
    lineageId: input.id,
    repairCount: 0,
    supersededBy: null,
    status: "pending",
    attemptId: null,
    toolCallId: null,
    runId: null,
    report: null,
    evidence: [],
    blockers: [],
  };
}

export function transitionLedger(
  state: ExecutionLedger,
  input: unknown,
  attemptId = "attempt",
): ExecutionLedger {
  validateLedger(state);
  if (!Value.Check(CheckpointSchema, input)) {
    throw new Error("Invalid execute_checkpoint input");
  }
  if (state.invocationId !== input.invocationId) {
    throw new Error("Stale execution authorization");
  }
  if (input.action === "inspect") {
    return structuredClone(state);
  }
  if (input.action === "stop") {
    return interruptLedger(
      state,
      "Execution stopped; explicit /execute and current-state reconciliation required",
    );
  }
  if (input.action === "accept") {
    if (state.plan !== null) {
      throw new Error(
        "One plan is already accepted; unfinished lineage cannot be reset",
      );
    }
    return validateLedger({
      ...state,
      plan: input.plan,
      approval: input.approval,
      assignments: input.assignments.map(makeAssignment),
    });
  }
  if (!state.plan) {
    throw new Error("Accept a canonical plan before assignments");
  }
  const item = requireAssignment(state, input.assignmentId);
  if (item.supersededBy) {
    throw new Error("Assignment has been superseded; use its latest repair");
  }
  if (input.action === "start") {
    if (item.status !== "pending") {
      throw new Error("Only pending assignments can start");
    }
    if (
      item.dependencies.some(
        (id) => latestAssignment(state, id).status !== "completed",
      )
    ) {
      throw new Error("Dependencies must be main-verified before dispatch");
    }
    const active = state.assignments.filter(
      (assignment) => assignment.status === "running",
    );
    if (active.length >= 4) {
      throw new Error("At most four active execution assignments");
    }
    if (active.some((assignment) => scopesOverlap(item, assignment))) {
      throw new Error("Active write scopes overlap");
    }
    return replaceAssignment(state, { ...item, status: "running", attemptId });
  }
  if (input.action === "block") {
    if (item.status === "completed") {
      throw new Error("Cannot reset a completed assignment");
    }
    return replaceAssignment(state, {
      ...item,
      status: "blocked",
      blockers: [...input.blockers],
    });
  }
  if (input.action === "verify") {
    if (item.attemptId !== input.attemptId) {
      throw new Error("Stale verification attempt");
    }
    if (
      !item.report ||
      item.report.status !== "done" ||
      !["running", "blocked"].includes(item.status)
    ) {
      throw new Error(
        "Verification requires a bound done claim, not completion fabricated from prose",
      );
    }
    if (input.passed !== (input.blockers.length === 0)) {
      throw new Error("Verification outcome and blockers disagree");
    }
    if (
      input.passed &&
      item.dependencies.some(
        (id) => latestAssignment(state, id).status !== "completed",
      )
    ) {
      throw new Error("Dependencies must remain main-verified");
    }
    return replaceAssignment(state, {
      ...item,
      status: input.passed ? "completed" : "blocked",
      // Each native snapshot retains history; the current assignment records
      // only the latest independent verification, within the schema's bound.
      evidence: [...input.evidence],
      blockers: [...input.blockers],
    });
  }
  if (item.status !== "blocked") {
    throw new Error("Only blocked assignments can receive scoped repairs");
  }
  if (item.repairCount >= MAX_REPAIRS) {
    throw new Error(
      "Mutation repair budget exhausted (two per original lineage)",
    );
  }
  const repair = {
    ...makeAssignment({
      id: input.newAssignmentId,
      task: input.task,
      scope: item.scope,
      dependencies: item.dependencies,
    }),
    lineageId: item.lineageId,
    repairCount: item.repairCount + 1,
  };
  return validateLedger({
    ...state,
    assignments: [
      ...state.assignments.map((assignment) =>
        assignment.id === item.id
          ? { ...assignment, supersededBy: repair.id }
          : assignment,
      ),
      repair,
    ],
  });
}

export function interruptLedger(
  state: ExecutionLedger,
  reason: string,
): ExecutionLedger {
  return validateLedger({
    ...state,
    assignments: state.assignments.map((item) =>
      item.status === "running"
        ? { ...item, status: "blocked", blockers: [reason] }
        : item,
    ),
  });
}

export function isLedgerComplete(state: ExecutionLedger): boolean {
  return (
    state.plan !== null &&
    state.assignments.every(
      (item) => latestAssignment(state, item.id).status === "completed",
    )
  );
}

export function dispatchPrefix(
  state: ExecutionLedger,
  assignment: Assignment,
): string {
  return `Execution binding: ${state.invocationId}/${assignment.id}/${assignment.attemptId}\n`;
}

function requireAttempt(
  state: ExecutionLedger,
  assignmentId: string,
  attemptId: string,
): Assignment {
  const item = requireAssignment(state, assignmentId);
  if (
    item.attemptId !== attemptId ||
    item.status !== "running" ||
    item.supersededBy
  ) {
    throw new Error("Stale execution result or attempt");
  }
  return item;
}

export function bindCall(
  state: ExecutionLedger,
  assignmentId: string,
  attemptId: string,
  toolCallId: string,
): ExecutionLedger {
  const item = requireAttempt(state, assignmentId, attemptId);
  if (item.toolCallId) {
    throw new Error("Execution attempt already bound to a subagent call");
  }
  return replaceAssignment(state, { ...item, toolCallId });
}

export function recordReport(
  state: ExecutionLedger,
  assignmentId: string,
  attemptId: string,
  toolCallId: string,
  runId: string,
  report: unknown,
): ExecutionLedger {
  const item = requireAttempt(state, assignmentId, attemptId);
  if (item.toolCallId !== toolCallId) {
    throw new Error("Worker result is not from the bound subagent call");
  }
  if (item.report) {
    throw new Error("Worker result already recorded");
  }
  const valid = validateReport(report);
  return replaceAssignment(state, {
    ...item,
    runId,
    report: structuredClone(valid),
    status: valid.status === "done" ? "running" : "blocked",
    blockers: [...valid.blockers],
  });
}

export function restoreLedger(
  branch: readonly unknown[],
  sessionId: string,
): ExecutionLedger | null {
  let latest: ExecutionLedger | null = null;
  for (const entry of branch) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("type" in entry) ||
      entry.type !== "custom" ||
      !("customType" in entry) ||
      entry.customType !== LEDGER_ENTRY_TYPE
    ) {
      continue;
    }
    if (!("data" in entry)) {
      throw new Error("Execution ledger entry lacks data");
    }
    const valid = validateLedger(entry.data);
    if (valid.sessionId !== sessionId) {
      throw new Error("Execution ledger belongs to another session");
    }
    latest = structuredClone(valid);
  }
  return latest;
}
