import { Value } from "typebox/value";

import {
  type Assignment,
  type AssignmentInput,
  CheckpointSchema,
  type ExecutionLedger,
  LedgerSchema,
  type SpecResume,
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
    specPath: null,
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

// Normalized cwd: workspace-relative inside the workspace, absolute outside.
function checkCwd(cwd: string): void {
  const parts =
    cwd === "/" ? [] : (cwd.startsWith("/") ? cwd.slice(1) : cwd).split("/");
  if (
    hasControlCharacters(cwd) ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Assignment cwd must be a normalized directory path");
  }
}

function scopePaths(item: Assignment): string[] {
  const { cwd } = item;
  if (!cwd) {
    return item.scope;
  }
  const base = cwd === "/" ? "" : cwd;
  return item.scope.map((scope) => (scope === "." ? cwd : `${base}/${scope}`));
}

function containsPath(parent: string, child: string): boolean {
  if (parent === ".") {
    return !child.startsWith("/");
  }
  return (
    child === parent ||
    child.startsWith(parent.endsWith("/") ? parent : `${parent}/`)
  );
}

function scopesOverlap(a: Assignment, b: Assignment): boolean {
  const right = scopePaths(b);
  return scopePaths(a).some((left) =>
    right.some((path) => containsPath(left, path) || containsPath(path, left)),
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

function sameCriteria(
  criteria: readonly string[],
  evidence: readonly { id: string }[] | undefined,
): boolean {
  const ids = (evidence ?? []).map((entry) => entry.id);
  return (
    ids.length === criteria.length &&
    new Set(ids).size === ids.length &&
    ids.every((id) => criteria.includes(id))
  );
}

function validateCriteria(input: ExecutionLedger): void {
  const { specCriteria } = input;
  if (specCriteria === undefined) {
    if (
      input.assignments.some(
        (item) =>
          item.criteria !== undefined || item.criteriaEvidence !== undefined,
      )
    ) {
      throw new Error("Assignment criteria require a Spec with Done Criteria");
    }
    return;
  }
  if (!input.specPath) {
    throw new Error("Done Criteria require a Spec-backed plan");
  }
  if (new Set(specCriteria).size !== specCriteria.length) {
    throw new Error("Repeated Done Criterion labels");
  }
  for (const item of input.assignments) {
    if (!item.criteria) {
      throw new Error(`Spec-backed assignment requires criteria: ${item.id}`);
    }
    if (new Set(item.criteria).size !== item.criteria.length) {
      throw new Error(`Duplicate assignment criteria: ${item.id}`);
    }
    const unknown = item.criteria.find((id) => !specCriteria.includes(id));
    if (unknown) {
      throw new Error(`Unknown Done Criterion: ${unknown}`);
    }
  }
  const uncovered = specCriteria.find(
    (id) => !input.assignments.some((item) => item.criteria?.includes(id)),
  );
  if (uncovered) {
    throw new Error(
      `Done Criterion not declared by any assignment: ${uncovered}`,
    );
  }
}

export function validateLedger(input: unknown): ExecutionLedger {
  if (!Value.Check(LedgerSchema, input)) {
    throw new Error("Invalid persisted execution ledger");
  }
  validateGraph(input.assignments);
  validateCriteria(input);
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
    if (item.cwd !== undefined) {
      checkCwd(item.cwd);
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
    if (item.repairCount + (item.priorRepairs ?? 0) > MAX_REPAIRS) {
      throw new Error("Mutation repair budget exceeds lineage limit");
    }
    if ((item.priorRepairs ?? 0) !== (root.priorRepairs ?? 0)) {
      throw new Error("Repair changed prior repairs");
    }
    if (
      root.repairCount !== 0 ||
      root.cwd !== item.cwd ||
      JSON.stringify(root.scope) !== JSON.stringify(item.scope) ||
      JSON.stringify(root.dependencies) !== JSON.stringify(item.dependencies) ||
      JSON.stringify(root.criteria) !== JSON.stringify(item.criteria)
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
      item.executor === "main" &&
      (!["running", "blocked", "completed"].includes(item.status) ||
        !item.attemptId ||
        item.toolCallId ||
        item.runId ||
        item.report)
    ) {
      throw new Error("Invalid main-executed attempt");
    }
    if (
      item.status === "pending" &&
      (item.attemptId ||
        item.toolCallId ||
        item.runId ||
        item.report ||
        item.evidence.length ||
        item.criteriaEvidence?.length ||
        item.blockers.length)
    ) {
      throw new Error("Invalid pending assignment");
    }
    if (
      item.status === "reverify" &&
      (item.resumed !== true ||
        item.attemptId ||
        item.toolCallId ||
        item.runId ||
        item.report ||
        item.evidence.length ||
        item.criteriaEvidence?.length ||
        item.blockers.length)
    ) {
      throw new Error("Invalid reverify assignment");
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
      ((item.report
        ? item.report.status !== "done"
        : item.executor !== "main" && item.resumed !== true) ||
        !item.evidence.length ||
        item.blockers.length)
    ) {
      throw new Error(
        "Completion requires main verification evidence and a done claim",
      );
    }
    if (
      item.status === "completed" &&
      item.criteria &&
      !sameCriteria(item.criteria, item.criteriaEvidence)
    ) {
      throw new Error(
        "Completion requires evidence for each declared criterion",
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
  if (active.length > 1 && active.some((item) => item.executor === "main")) {
    throw new Error("A main-executed attempt must run alone");
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
  resume?: SpecResume,
  // Parsed from the Spec by runtime at accept, never supplied by the agent.
  specCriteria?: string[],
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
  if (input.action === "review" || input.action === "resolve_review") {
    throw new Error("Spec review actions never change the ledger");
  }
  if (input.action === "accept") {
    if (state.plan !== null) {
      throw new Error(
        "One plan is already accepted; unfinished lineage cannot be reset",
      );
    }
    if (resume && !input.specPath) {
      throw new Error("Resuming requires specPath");
    }
    if (input.specPath && !specCriteria) {
      throw new Error("Spec-backed accept requires parsed Done Criteria");
    }
    if (resume && input.reviseSpec !== true) {
      const acceptedIds = new Set(input.assignments.map((item) => item.id));
      if (
        [...resume.verified, ...Object.keys(resume.priorRepairs)].some(
          (id) => !acceptedIds.has(id),
        )
      ) {
        throw new Error(
          "Resumed spec lineage missing from accepted plan; revise the spec explicitly",
        );
      }
    }
    return validateLedger({
      ...state,
      plan: input.plan,
      approval: input.approval,
      specPath: input.specPath ?? null,
      ...(input.specPath && specCriteria
        ? { specCriteria: [...specCriteria] }
        : {}),
      assignments: input.assignments.map((assignment) => {
        const item = makeAssignment(assignment);
        if (resume) {
          item.priorRepairs = resume.priorRepairs[item.id] ?? 0;
          if (resume.verified.includes(item.id)) {
            item.status = "reverify";
            item.resumed = true;
          } else if (Object.hasOwn(resume.blocked, item.id)) {
            item.status = "blocked";
            item.blockers = [...resume.blocked[item.id]];
          }
        }
        return item;
      }),
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
    // A root carrying spent repairs was never budgeted for a new mutation.
    if (item.repairCount === 0 && (item.priorRepairs ?? 0) > 0) {
      throw new Error(
        "Resumed lineage has spent repairs; use repair before dispatch",
      );
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
    // Main's own attempt edits the shared checkout; it runs alone.
    if (input.executor === "main" && active.length > 0) {
      throw new Error(
        "Main-executed attempts require no other running assignment",
      );
    }
    if (input.executor === "main" && item.cwd?.startsWith("/")) {
      throw new Error(
        "Main-executed attempts cannot run outside the workspace",
      );
    }
    if (active.some((assignment) => assignment.executor === "main")) {
      throw new Error(
        "A main-executed attempt is running; verify or block it first",
      );
    }
    return replaceAssignment(state, {
      ...item,
      status: "running",
      attemptId,
      ...(input.executor === "main" ? { executor: "main" as const } : {}),
    });
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
    if (item.status === "reverify") {
      if (input.attemptId !== undefined) {
        throw new Error("Reverification must not include an attemptId");
      }
    } else {
      if (input.attemptId === undefined) {
        throw new Error("Verification requires the running attemptId");
      }
      if (item.attemptId !== input.attemptId) {
        throw new Error("Stale verification attempt");
      }
      if (item.executor === "main") {
        // Main's own attempt has no child claim; the runtime gates verify on
        // a successful check run after main's last edit in this attempt.
        if (item.status !== "running") {
          throw new Error(
            "Main-executed verification requires a running attempt",
          );
        }
      } else if (
        !item.report ||
        item.report.status !== "done" ||
        !["running", "blocked"].includes(item.status)
      ) {
        throw new Error(
          "Verification requires a bound done claim, not completion fabricated from prose",
        );
      }
    }
    if (input.passed !== (input.blockers.length === 0)) {
      throw new Error("Verification outcome and blockers disagree");
    }
    if (input.criteria && !item.criteria) {
      throw new Error(
        "Verification criteria require Spec-backed assignment criteria",
      );
    }
    if (
      input.passed &&
      item.criteria &&
      !sameCriteria(item.criteria, input.criteria)
    ) {
      throw new Error(
        "Passing verification requires evidence for each declared criterion",
      );
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
      ...(item.criteria
        ? { criteriaEvidence: structuredClone(input.criteria ?? []) }
        : {}),
      blockers: [...input.blockers],
    });
  }
  if (item.status !== "blocked") {
    throw new Error("Only blocked assignments can receive scoped repairs");
  }
  if (item.repairCount + (item.priorRepairs ?? 0) >= MAX_REPAIRS) {
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
      ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
      ...(item.criteria === undefined ? {} : { criteria: item.criteria }),
    }),
    lineageId: item.lineageId,
    repairCount: item.repairCount + 1,
    ...(item.priorRepairs === undefined
      ? {}
      : { priorRepairs: item.priorRepairs }),
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
