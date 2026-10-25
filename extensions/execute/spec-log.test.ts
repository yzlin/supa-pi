import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Value } from "typebox/value";

import {
  bindCall,
  emptyLedger,
  interruptLedger,
  recordReport,
  transitionLedger,
} from "./ledger";
import type { ExecutionLedger, SpecResume } from "./schema";
import {
  appendSpecEvents,
  deleteSnapshotRefs,
  deriveCriteriaStates,
  deriveSpecResume,
  hashSpec,
  INTERRUPTED_BLOCKER,
  parseDoneCriteria,
  parseSpecPath,
  readSpecLog,
  renderSpecStatus,
  reviewState,
  snapshotWorkspace,
  SPECS_DIR,
  SPEC_SLUG_PATTERN,
  type SpecLogEvent,
  SpecLogEventSchema,
  specEventsFromTransition,
} from "./spec-log";

const ts = "2026-10-12T12:00:00.000Z";
const hash = "a".repeat(64);
const specPath = ".pi/specs/example.md";
const accepted: SpecLogEvent = {
  event: "accepted",
  ts,
  hash,
  invocationId: "invocation",
  assignments: [
    { id: "a", dependencies: [] },
    { id: "b", dependencies: ["a"] },
  ],
};
const verified: SpecLogEvent = {
  event: "verified",
  ts,
  assignment: "a-fix",
  lineageId: "a",
  repairCount: 1,
  priorRepairs: 1,
  resumed: false,
  evidence: ["bun test: passed"],
  head: null,
  snapshot: null,
};
const blocked: SpecLogEvent = {
  event: "blocked",
  ts,
  assignment: "b",
  lineageId: "b",
  repairCount: 0,
  priorRepairs: 1,
  blockers: ["Missing prerequisite"],
};
const repaired: SpecLogEvent = {
  event: "repaired",
  ts,
  assignment: "a-fix",
  from: "a",
  lineageId: "a",
  repairCount: 1,
  priorRepairs: 1,
};
const done: SpecLogEvent = { event: "done", ts };
const reviewed: SpecLogEvent = {
  event: "reviewed",
  ts,
  hash,
  round: 1,
  trigger: { source: "fallback", dcCount: 9, reason: "no consent" },
  decision: "revise",
  answers: [
    {
      id: "0:q1",
      focus: "Plan risks",
      question: "Split DC-3?",
      answer: "Option A",
    },
  ],
  findings: 2,
};
const dirs: string[] = [];
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), "pi-spec-log-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}
function repository(commit = true) {
  const cwd = temporary();
  git(cwd, "init");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@localhost");
  writeFileSync(join(cwd, "tracked.txt"), "original\n");
  git(cwd, "add", "tracked.txt");
  if (commit) {
    git(cwd, "commit", "-m", "initial");
  }
  return cwd;
}
function step(
  state: ExecutionLedger,
  input: Record<string, unknown>,
  resume?: SpecResume,
) {
  return transitionLedger(
    state,
    { invocationId: state.invocationId, ...input },
    "attempt-a",
    resume,
    input.specPath ? ["DC-1"] : undefined,
  );
}
const proof = [{ id: "DC-1", evidence: "DC-1 test passed" }];
function ledger(path: string | null = specPath, resume?: SpecResume) {
  return step(
    emptyLedger("session", "invocation"),
    {
      action: "accept",
      plan: "Canonical brief",
      approval: "Safe local changes",
      ...(path === null ? {} : { specPath: path }),
      assignments: [
        {
          id: "a",
          task: "Implement A",
          scope: ["src/a"],
          dependencies: [],
          ...(path === null ? {} : { criteria: ["DC-1"] }),
        },
      ],
    },
    resume,
  );
}
function complete(state: ExecutionLedger, id = "a") {
  const bound = bindCall(state, id, "attempt-a", "call-a");
  const reported = recordReport(bound, id, "attempt-a", "call-a", "run-a", {
    status: "done",
    summary: "Implemented",
    filesTouched: ["src/a"],
    validation: ["bun test: passed"],
    followUps: [],
    blockers: [],
  });
  return step(reported, {
    action: "verify",
    assignmentId: id,
    attemptId: "attempt-a",
    passed: true,
    evidence: ["Main inspected; bun test: passed"],
    blockers: [],
    ...(state.specPath ? { criteria: proof } : {}),
  });
}

describe("Spec paths and hashes", () => {
  it("accepts only exact workspace-relative paths with bounded lowercase slugs", () => {
    expect(SPECS_DIR).toBe(".pi/specs");
    expect(SPEC_SLUG_PATTERN.source).toBe("^[a-z0-9][a-z0-9-]*$");
    for (const slug of ["a", "0", "a-b-9", "a".repeat(48)]) {
      expect(parseSpecPath(`.pi/specs/${slug}.md`)).toEqual({
        slug,
        specPath: `.pi/specs/${slug}.md`,
        logPath: `.pi/specs/${slug}.log.jsonl`,
      });
    }
    for (const path of [
      "",
      "./.pi/specs/a.md",
      "/.pi/specs/a.md",
      ".pi/specs/../a.md",
      ".pi/specs/a/b.md",
      ".pi/specs/a.MD",
      ".pi/specs/A.md",
      ".pi/specs/-a.md",
      ".pi/specs/a_b.md",
      ".pi/specs/.md",
      ".pi/specs/a.md/",
      ".pi/specs/a.md\n",
      ".pi/specs/a\n.md",
      ".pi/specs/a\r.md",
      ".pi/specs/a\u2028.md",
      ".pi/specs/a\u2029.md",
      ".pi/specs/a b.md",
      ".pi/specs/á.md",
      ".pi/specs/a\\b.md",
      ".pi//specs/a.md",
      `.pi/specs/${"a".repeat(49)}.md`,
      ".pi/specs/a.log.jsonl",
    ]) {
      expect(() => parseSpecPath(path)).toThrow();
    }
  });
  it("hashes exact content with sha256", () => {
    expect(hashSpec("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hashSpec("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hashSpec("abc\n")).not.toBe(hashSpec("abc"));
  });
});

describe("Spec event log", () => {
  it("validates all closed event variants and ISO timestamps", () => {
    const events: SpecLogEvent[] = [
      accepted,
      { event: "revised", ts, hash, previousHash: "b".repeat(64) },
      {
        event: "started",
        ts,
        assignment: "a",
        lineageId: "a",
        attemptId: "attempt",
      },
      verified,
      { ...verified, snapshotError: "git failed" },
      blocked,
      repaired,
      { event: "stopped", ts, reason: "User stopped" },
      done,
      reviewed,
      {
        ...reviewed,
        decision: "accept",
        trigger: {
          source: "classifier",
          probability: 0.5,
          model: "typesafe/jev-latest",
        },
      },
    ];
    for (const event of events) {
      expect(Value.Check(SpecLogEventSchema, event)).toBe(true);
      expect(Value.Check(SpecLogEventSchema, { ...event, extra: true })).toBe(
        false,
      );
      expect(
        Value.Check(SpecLogEventSchema, { ...event, ts: "yesterday" }),
      ).toBe(false);
    }
    expect(
      Value.Check(SpecLogEventSchema, {
        ...accepted,
        assignments: [{ id: "a", dependencies: [], extra: true }],
      }),
    ).toBe(false);
    expect(
      Value.Check(SpecLogEventSchema, { ...verified, repairCount: -1 }),
    ).toBe(false);
    for (const invalid of [
      { round: 0 },
      { findings: -1 },
      { decision: "maybe" },
      { answers: [{ id: "0:q1" }] },
      { answers: [{ id: "0:q1", answer: "Option A" }] },
      { trigger: { source: "classifier", probability: 2, model: "x/y" } },
      { trigger: { source: "classifier", probability: 0.5, model: "jev" } },
      { trigger: { source: "fallback", dcCount: 1.5, reason: "x" } },
      { trigger: { source: "other" } },
    ]) {
      expect(Value.Check(SpecLogEventSchema, { ...reviewed, ...invalid })).toBe(
        false,
      );
    }
  });
  it("allows reviewed events before the first accepted event", () => {
    const path = join(temporary(), "example.log.jsonl");
    appendSpecEvents(path, [reviewed, accepted, done]);
    expect(readSpecLog(path)).toEqual([reviewed, accepted, done]);
    writeFileSync(
      path,
      `${JSON.stringify(reviewed)}\n${JSON.stringify(done)}\n`,
    );
    expect(() => readSpecLog(path)).toThrow(`Corrupt Spec log ${path}:2`);
  });
  it("derives review approval for the current hash and counts reviewed hashes", () => {
    const other = "b".repeat(64);
    expect(reviewState([], hash)).toEqual({
      approved: false,
      latestDecision: null,
      reviewedHashes: 0,
    });
    expect(reviewState([reviewed], hash)).toEqual({
      approved: false,
      latestDecision: reviewed.decision,
      reviewedHashes: 1,
    });
    const events: SpecLogEvent[] = [
      reviewed,
      { ...reviewed, hash: other, decision: "accept" },
      { ...reviewed, hash: other, round: 2, decision: "stop" },
    ];
    expect(reviewState(events, hash)).toEqual({
      approved: false,
      latestDecision: reviewed.decision,
      reviewedHashes: 2,
    });
    // Latest reviewed decision for the hash, by log order, decides approval.
    expect(reviewState(events, other)).toEqual({
      approved: false,
      latestDecision: "stop",
      reviewedHashes: 2,
    });
    expect(
      reviewState(
        [...events, { ...reviewed, hash: other, decision: "accept" }],
        other,
      ),
    ).toEqual({ approved: true, latestDecision: "accept", reviewedHashes: 2 });
  });
  it("reads missing logs, round trips events, and appends without rewriting", () => {
    const path = join(temporary(), ".pi/specs/example.log.jsonl");
    expect(readSpecLog(path)).toEqual([]);
    appendSpecEvents(path, [accepted]);
    const initial = readFileSync(path, "utf8");
    expect(initial).toBe(`${JSON.stringify(accepted)}\n`);
    appendSpecEvents(path, [verified, done]);
    expect(readFileSync(path, "utf8")).toBe(
      `${initial}${JSON.stringify(verified)}\n${JSON.stringify(done)}\n`,
    );
    expect(readSpecLog(path)).toEqual([accepted, verified, done]);
    appendSpecEvents(path, []);
    expect(readSpecLog(path)).toEqual([accepted, verified, done]);
  });
  it("preserves a valid unterminated final line when appending", () => {
    const path = join(temporary(), "example.log.jsonl");
    const initial = JSON.stringify(accepted);
    writeFileSync(path, initial);
    appendSpecEvents(path, [verified]);
    expect(readFileSync(path, "utf8")).toBe(
      `${initial}\n${JSON.stringify(verified)}\n`,
    );
    expect(readSpecLog(path)).toEqual([accepted, verified]);
  });
  it("ignores empty lines but fails closed on malformed or invalid events", () => {
    const path = join(temporary(), "example.log.jsonl");
    writeFileSync(
      path,
      `\n${JSON.stringify(accepted)}\n\n${JSON.stringify(done)}\n`,
    );
    expect(readSpecLog(path)).toEqual([accepted, done]);
    for (const invalid of [
      "{bad",
      JSON.stringify({ ...verified, extra: true }),
      JSON.stringify({ event: "done", ts: "bad" }),
      "null",
    ]) {
      writeFileSync(path, `${JSON.stringify(accepted)}\n\n${invalid}\n`);
      expect(() => readSpecLog(path)).toThrow(`Corrupt Spec log ${path}:3`);
    }
    writeFileSync(path, `\n${JSON.stringify(done)}\n`);
    expect(() => readSpecLog(path)).toThrow(`Corrupt Spec log ${path}:2`);
    writeFileSync(path, "\n\n");
    expect(readSpecLog(path)).toEqual([]);
  });
});

describe("Spec Done Criteria", () => {
  const spec = (rows: string) =>
    `# Execution Brief\n\n## Plan\n- not a DC\n\n## Done Criteria\n${rows}\n## Verification\n- check\n`;
  it("parses unique DC-n labels from the Done Criteria section only", () => {
    expect(
      parseDoneCriteria(
        spec(
          "- DC-1: First (US-1)\n  continued\n\n- DC-2: Second (technical)\n",
        ),
      ),
    ).toEqual(["DC-1", "DC-2"]);
  });
  it("rejects unlabeled rows, repeated labels, empty and missing sections", () => {
    expect(() => parseDoneCriteria(spec("- DC-1: A\n- Unlabeled\n"))).toThrow(
      "Done Criteria row lacks a DC-n: label",
    );
    expect(() => parseDoneCriteria(spec("- DC-0: Zero\n"))).toThrow(
      "lacks a DC-n: label",
    );
    expect(() => parseDoneCriteria(spec("- DC-1: A\n- DC-1: B\n"))).toThrow(
      "Repeated Done Criterion label: DC-1",
    );
    expect(() => parseDoneCriteria(spec("\n"))).toThrow("has no rows");
    expect(() => parseDoneCriteria("# Execution Brief\n## Plan\n")).toThrow(
      "no ## Done Criteria section",
    );
  });
  it("parses pre-gate done logs without Done Criterion fields", () => {
    const path = join(temporary(), "legacy.log.jsonl");
    const legacy = [
      {
        event: "accepted",
        ts,
        hash,
        invocationId: "old",
        assignments: [{ id: "a", dependencies: [] }],
      },
      {
        ts,
        assignment: "a",
        lineageId: "a",
        repairCount: 0,
        priorRepairs: 0,
        event: "verified",
        resumed: false,
        evidence: ["Old"],
        head: null,
        snapshot: null,
      },
      { event: "done", ts },
    ];
    writeFileSync(
      path,
      legacy.map((event) => JSON.stringify(event)).join("\n"),
    );
    expect(readSpecLog(path)).toEqual(legacy as SpecLogEvent[]);
    expect(deriveCriteriaStates(readSpecLog(path))).toEqual([]);
  });
  it("derives passed, pending and unmet criteria from the latest acceptance", () => {
    const gated: SpecLogEvent = {
      ...accepted,
      criteria: ["DC-1", "DC-2", "DC-3"],
      assignments: [
        { id: "a", dependencies: [], criteria: ["DC-1", "DC-2"] },
        { id: "b", dependencies: ["a"], criteria: ["DC-2", "DC-3"] },
      ],
    };
    const proved: SpecLogEvent = {
      ...verified,
      criteria: [
        { id: "DC-1", evidence: "one" },
        { id: "DC-2", evidence: "two" },
      ],
    };
    const states = (events: SpecLogEvent[]) =>
      deriveCriteriaStates(events).map(({ state }) => state);
    expect(states([gated])).toEqual(["pending", "pending", "pending"]);
    expect(states([gated, proved])).toEqual(["passed", "pending", "pending"]);
    // b's repair budget is exhausted: DC-2 and DC-3 can never pass, so unmet.
    expect(states([gated, proved, blocked])).toEqual([
      "passed",
      "pending",
      "pending",
    ]);
    const exhausted: SpecLogEvent = { ...blocked, repairCount: 1 };
    expect(states([gated, proved, exhausted])).toEqual([
      "passed",
      "unmet",
      "unmet",
    ]);
    expect(
      states([gated, proved, { event: "stopped", ts, reason: "Stop" }]),
    ).toEqual(["passed", "unmet", "unmet"]);
    // Logged evidence before a later acceptance is history only.
    expect(states([gated, proved, gated])).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    // Later progress in a verified lineage reopens its criteria.
    expect(states([gated, proved, repaired])).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });
});

describe("Spec resume", () => {
  it("derives verified lineages, cumulative repair budgets, current hash and done", () => {
    expect(deriveSpecResume([])).toEqual({
      hash: null,
      resume: null,
      done: false,
    });
    expect(deriveSpecResume([accepted])).toEqual({
      hash,
      resume: { verified: [], blocked: {}, priorRepairs: {} },
      done: false,
    });
    // Review alone is not acceptance; review after acceptance changes nothing.
    expect(deriveSpecResume([reviewed, reviewed])).toEqual({
      hash: null,
      resume: null,
      done: false,
    });
    expect(deriveSpecResume([reviewed, accepted, reviewed])).toEqual({
      hash,
      resume: { verified: [], blocked: {}, priorRepairs: {} },
      done: false,
    });
    const events: SpecLogEvent[] = [
      accepted,
      repaired,
      verified,
      blocked,
      { event: "revised", ts, hash: "b".repeat(64), previousHash: hash },
      done,
    ];
    expect(deriveSpecResume(events)).toEqual({
      hash: "b".repeat(64),
      resume: {
        verified: ["a"],
        blocked: { b: ["Missing prerequisite"] },
        priorRepairs: { a: 2, b: 1 },
      },
      done: true,
    });
    expect(
      deriveSpecResume([
        ...events,
        { ...blocked, assignment: "a", lineageId: "a", priorRepairs: 0 },
      ]),
    ).toEqual({
      hash: "b".repeat(64),
      resume: {
        verified: [],
        blocked: {
          a: ["Missing prerequisite"],
          b: ["Missing prerequisite"],
        },
        priorRepairs: { a: 2, b: 1 },
      },
      done: false,
    });
  });
  it("invalidates verification on later start or repair in the same lineage", () => {
    for (const event of [
      repaired,
      {
        event: "started",
        ts,
        assignment: "a-new",
        lineageId: "a",
        attemptId: "new",
      } satisfies SpecLogEvent,
    ]) {
      expect(deriveSpecResume([accepted, verified, event]).resume).toEqual({
        verified: [],
        blocked: { a: [INTERRUPTED_BLOCKER] },
        priorRepairs: { a: 2 },
      });
    }
    expect(
      deriveSpecResume([accepted, { ...blocked, priorRepairs: 0 }]).resume
        ?.priorRepairs,
    ).toEqual({});
    expect(
      deriveSpecResume([
        accepted,
        { event: "revised", ts, hash: "b".repeat(64), previousHash: hash },
        { ...accepted, hash: "c".repeat(64) },
      ]).hash,
    ).toBe("c".repeat(64));
  });
  it("drops lineages removed by a revision from the resume", () => {
    expect(
      deriveSpecResume([
        accepted,
        verified,
        blocked,
        { event: "revised", ts, hash: "b".repeat(64), previousHash: hash },
        {
          ...accepted,
          hash: "b".repeat(64),
          assignments: [{ id: "b", dependencies: [] }],
        },
      ]).resume,
    ).toEqual({
      verified: [],
      blocked: { b: ["Missing prerequisite"] },
      priorRepairs: { b: 1 },
    });
  });
  it("restores logged blocked and interrupted lineages as blocked, leaving untouched ones pending", () => {
    expect(INTERRUPTED_BLOCKER).toBe(
      "Interrupted in a prior session; repair required",
    );
    const started: SpecLogEvent = {
      event: "started",
      ts,
      assignment: "a",
      lineageId: "a",
      attemptId: "attempt",
    };
    expect(deriveSpecResume([accepted, started]).resume).toEqual({
      verified: [],
      blocked: { a: [INTERRUPTED_BLOCKER] },
      priorRepairs: {},
    });
    expect(
      deriveSpecResume([
        accepted,
        { ...blocked, assignment: "a", lineageId: "a", priorRepairs: 2 },
      ]).resume,
    ).toEqual({
      verified: [],
      blocked: { a: ["Missing prerequisite"] },
      priorRepairs: { a: 2 },
    });
    expect(
      deriveSpecResume([accepted, { ...repaired, priorRepairs: 0 }]).resume,
    ).toEqual({
      verified: [],
      blocked: { a: [INTERRUPTED_BLOCKER] },
      priorRepairs: { a: 1 },
    });
  });
});

describe("Spec ledger transition events", () => {
  it("emits started, verified and done only for actual status transitions", () => {
    const pending = ledger();
    expect(specEventsFromTransition(null, pending, ts)).toEqual([]);
    const running = step(pending, { action: "start", assignmentId: "a" });
    expect(specEventsFromTransition(pending, running, ts)).toEqual([
      {
        event: "started",
        ts,
        assignment: "a",
        lineageId: "a",
        attemptId: "attempt-a",
      },
    ]);
    const completed = complete(running);
    expect(specEventsFromTransition(running, completed, ts)).toEqual([
      {
        event: "verified",
        ts,
        assignment: "a",
        lineageId: "a",
        repairCount: 0,
        priorRepairs: 0,
        resumed: false,
        evidence: ["Main inspected; bun test: passed"],
        criteria: proof,
        head: null,
        snapshot: null,
      },
      done,
    ]);
    expect(specEventsFromTransition(completed, completed, ts)).toEqual([]);
    expect(specEventsFromTransition(null, completed, ts)).toHaveLength(2);
    expect(
      specEventsFromTransition(
        emptyLedger("session", "invocation"),
        completed,
        ts,
      ),
    ).toHaveLength(2);
    expect(specEventsFromTransition(null, ledger(null), ts)).toEqual([]);
    expect(
      specEventsFromTransition(pending, { ...completed, specPath: null }, ts),
    ).toEqual([]);
  });
  it("emits blocked and new repaired assignments with lineage and prior budgets", () => {
    const pending = ledger(specPath, {
      verified: [],
      blocked: {},
      priorRepairs: { a: 1 },
    });
    const failed = step(pending, {
      action: "block",
      assignmentId: "a",
      blockers: ["Test failure"],
    });
    expect(specEventsFromTransition(pending, failed, ts)).toEqual([
      {
        event: "blocked",
        ts,
        assignment: "a",
        lineageId: "a",
        repairCount: 0,
        priorRepairs: 1,
        blockers: ["Test failure"],
      },
    ]);
    const fixed = step(failed, {
      action: "repair",
      assignmentId: "a",
      newAssignmentId: "a-fix",
      task: "Fix test",
    });
    expect(specEventsFromTransition(failed, fixed, ts)).toEqual([
      {
        event: "repaired",
        ts,
        assignment: "a-fix",
        lineageId: "a",
        from: "a",
        repairCount: 1,
        priorRepairs: 1,
      },
    ]);
    const running = step(fixed, { action: "start", assignmentId: "a-fix" });
    const completed = complete(running, "a-fix");
    expect(specEventsFromTransition(running, completed, ts)).toEqual([
      {
        ...verified,
        evidence: ["Main inspected; bun test: passed"],
        criteria: proof,
      },
      done,
    ]);
    expect(specEventsFromTransition(fixed, fixed, ts)).toEqual([]);
  });
  it("logs only newly blocked work when a new invocation interrupts the same plan", () => {
    const pending = step(emptyLedger("session", "invocation"), {
      action: "accept",
      plan: "Canonical brief",
      approval: "Safe local changes",
      specPath,
      assignments: [
        {
          id: "a",
          task: "Implement A",
          scope: ["src/a"],
          dependencies: [],
          criteria: ["DC-1"],
        },
        {
          id: "b",
          task: "Implement B",
          scope: ["src/b"],
          dependencies: ["a"],
          criteria: ["DC-1"],
        },
      ],
    });
    const completed = complete(
      step(pending, { action: "start", assignmentId: "a" }),
    );
    const running = transitionLedger(
      completed,
      {
        invocationId: completed.invocationId,
        action: "start",
        assignmentId: "b",
      },
      "attempt-b",
    );
    const reason =
      "New explicit invocation; reconcile unfinished work before fresh children";
    const interrupted = {
      ...interruptLedger(running, reason),
      invocationId: "next",
    };
    expect(specEventsFromTransition(running, interrupted, ts)).toEqual([
      {
        event: "blocked",
        ts,
        assignment: "b",
        lineageId: "b",
        repairCount: 0,
        priorRepairs: 0,
        blockers: [reason],
      },
    ]);
  });
  it("logs fresh read-only reverify while isolating different plans and Spec paths", () => {
    const oldPending = ledger();
    const oldComplete = complete(
      step(oldPending, { action: "start", assignmentId: "a" }),
    );
    const resumed = {
      ...ledger(specPath, {
        verified: ["a"],
        blocked: {},
        priorRepairs: { a: 2 },
      }),
      invocationId: "next",
    };
    expect(specEventsFromTransition(oldComplete, resumed, ts)).toEqual([]);
    const completed = step(resumed, {
      action: "verify",
      assignmentId: "a",
      passed: true,
      evidence: ["Fresh test"],
      blockers: [],
      criteria: proof,
    });
    expect(specEventsFromTransition(oldComplete, completed, ts)).toEqual([]);
    expect(
      specEventsFromTransition(
        { ...oldComplete, specPath: ".pi/specs/other.md" },
        completed,
        ts,
      ),
    ).toHaveLength(2);
    expect(specEventsFromTransition(resumed, completed, ts)).toEqual([
      {
        event: "verified",
        ts,
        assignment: "a",
        lineageId: "a",
        repairCount: 0,
        priorRepairs: 2,
        resumed: true,
        evidence: ["Fresh test"],
        criteria: proof,
        head: null,
        snapshot: null,
      },
      done,
    ]);
    const newRunning = step(
      { ...ledger(), plan: "New brief" },
      { action: "start", assignmentId: "a" },
    );
    expect(
      specEventsFromTransition(
        { ...newRunning, plan: "Old brief" },
        newRunning,
        ts,
      ),
    ).toHaveLength(1);
  });
});

describe("Spec workspace snapshots", () => {
  it("captures tracked and untracked files without changing HEAD, status or the real index", () => {
    const cwd = repository();
    writeFileSync(join(cwd, "tracked.txt"), "staged\n");
    git(cwd, "add", "tracked.txt");
    writeFileSync(join(cwd, "tracked.txt"), "working tree\n");
    writeFileSync(join(cwd, "untracked.txt"), "untracked content\n");
    writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(cwd, "ignored.txt"), "ignored\n");
    const head = git(cwd, "rev-parse", "HEAD");
    const status = git(cwd, "status", "--porcelain");
    const index = readFileSync(join(cwd, ".git/index"));
    expect(snapshotWorkspace(cwd, "example", 1)).toEqual({
      head,
      snapshot: "refs/pi-specs/example/1",
    });
    expect(git(cwd, "show", "refs/pi-specs/example/1:untracked.txt")).toBe(
      "untracked content",
    );
    expect(git(cwd, "show", "refs/pi-specs/example/1:tracked.txt")).toBe(
      "working tree",
    );
    expect(
      git(cwd, "ls-tree", "--name-only", "refs/pi-specs/example/1"),
    ).not.toContain("ignored.txt");
    expect(
      git(
        cwd,
        "log",
        "-1",
        "--format=%s|%an|%ae|%cn|%ce",
        "refs/pi-specs/example/1",
      ),
    ).toBe(
      "pi-spec example #1|pi-spec|pi-spec@localhost|pi-spec|pi-spec@localhost",
    );
    expect(git(cwd, "rev-parse", "refs/pi-specs/example/1^")).toBe(head);
    expect(git(cwd, "status", "--porcelain")).toBe(status);
    expect(readFileSync(join(cwd, ".git/index"))).toEqual(index);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(head);
    snapshotWorkspace(cwd, "example", 2);
    snapshotWorkspace(cwd, "other", 1);
    deleteSnapshotRefs(cwd, "example");
    expect(
      git(cwd, "for-each-ref", "--format=%(refname)", "refs/pi-specs/example/"),
    ).toBe("");
    expect(
      git(cwd, "for-each-ref", "--format=%(refname)", "refs/pi-specs/other/"),
    ).toBe("refs/pi-specs/other/1");
  });
  it("returns nulls and deletion is a no-op outside git", () => {
    const cwd = temporary();
    expect(snapshotWorkspace(cwd, "example", 1)).toEqual({
      head: null,
      snapshot: null,
    });
    expect(() => deleteSnapshotRefs(cwd, "example")).not.toThrow();
  });
  it("snapshots unborn HEAD and a missing real index", () => {
    const cwd = repository(false);
    expect(snapshotWorkspace(cwd, "unborn", 1)).toEqual({
      head: null,
      snapshot: "refs/pi-specs/unborn/1",
    });
    expect(git(cwd, "show", "refs/pi-specs/unborn/1:tracked.txt")).toBe(
      "original",
    );
    const empty = temporary();
    git(empty, "init");
    writeFileSync(join(empty, "untracked.txt"), "new");
    expect(snapshotWorkspace(empty, "empty", 1)).toEqual({
      head: null,
      snapshot: "refs/pi-specs/empty/1",
    });
    expect(existsSync(join(empty, ".git/index"))).toBe(false);
  });
  it("uses the repository index when cwd is a subdirectory", () => {
    const cwd = repository();
    const nested = join(cwd, "nested");
    mkdirSync(nested);
    writeFileSync(join(cwd, "untracked.txt"), "root content");
    const index = readFileSync(join(cwd, ".git/index"));
    expect(snapshotWorkspace(nested, "nested", 1).snapshot).toBe(
      "refs/pi-specs/nested/1",
    );
    expect(git(cwd, "show", "refs/pi-specs/nested/1:untracked.txt")).toBe(
      "root content",
    );
    expect(readFileSync(join(cwd, ".git/index"))).toEqual(index);
  });
  it("reports git failures inside a work tree without throwing or changing the index", () => {
    const cwd = repository();
    const head = git(cwd, "rev-parse", "HEAD");
    git(cwd, "update-ref", "refs/pi-specs/broken", head);
    const index = readFileSync(join(cwd, ".git/index"));
    const result = snapshotWorkspace(cwd, "broken", 1);
    expect(result).toMatchObject({ head, snapshot: null });
    expect(result.snapshotError).toContain("refs/pi-specs/broken/1");
    expect(readFileSync(join(cwd, ".git/index"))).toEqual(index);
  });
});

describe("Spec status", () => {
  it("renders missing and empty directories and clear invalid/missing slug messages", () => {
    const cwd = temporary();
    const empty = "No specs in .pi/specs/. Run /to-spec after locking a plan.";
    expect(renderSpecStatus(cwd)).toBe(empty);
    mkdirSync(join(cwd, SPECS_DIR), { recursive: true });
    writeFileSync(
      join(cwd, SPECS_DIR, "orphan.log.jsonl"),
      JSON.stringify(accepted),
    );
    expect(renderSpecStatus(cwd)).toBe(empty);
    expect(renderSpecStatus(cwd, "../bad")).toContain("Invalid Spec slug");
    expect(renderSpecStatus(cwd, "a".repeat(49))).toContain(
      "Invalid Spec slug",
    );
    expect(renderSpecStatus(cwd, "missing")).toContain(
      "Spec not found: .pi/specs/missing.md",
    );
  });
  it("lists only Specs in slug order with ready, last-event and corrupt states", () => {
    const cwd = temporary();
    const dir = join(cwd, SPECS_DIR);
    mkdirSync(dir, { recursive: true });
    for (const slug of ["z-ready", "a-done", "b-bad", "c-reviewed"]) {
      writeFileSync(join(dir, `${slug}.md`), "Brief");
    }
    mkdirSync(join(dir, "not-a-file.md"));
    appendSpecEvents(join(dir, "a-done.log.jsonl"), [accepted, done]);
    writeFileSync(join(dir, "b-bad.log.jsonl"), "invalid");
    appendSpecEvents(join(dir, "c-reviewed.log.jsonl"), [reviewed]);
    expect(renderSpecStatus(cwd)).toBe(
      "a-done  done\nb-bad  corrupt\nc-reviewed  reviewed (not accepted)\nz-ready  ready",
    );
    expect(renderSpecStatus(cwd, "c-reviewed")).toContain(
      "Status: reviewed (not accepted)\nHash: none",
    );
    appendSpecEvents(join(dir, "c-reviewed.log.jsonl"), [accepted]);
    expect(renderSpecStatus(cwd)).toContain("c-reviewed  accepted\n");
    expect(renderSpecStatus(cwd, "b-bad")).toContain("Status: corrupt");
    expect(renderSpecStatus(cwd, "z-ready")).toContain("Status: ready");
  });
  it("renders deterministic log details and lineage states including pending roots", () => {
    const cwd = temporary();
    mkdirSync(join(cwd, SPECS_DIR), { recursive: true });
    writeFileSync(join(cwd, specPath), "Brief");
    const extra: SpecLogEvent = {
      ...accepted,
      assignments: [...accepted.assignments, { id: "c", dependencies: [] }],
    };
    appendSpecEvents(join(cwd, ".pi/specs/example.log.jsonl"), [
      extra,
      repaired,
      verified,
      blocked,
      done,
    ]);
    expect(renderSpecStatus(cwd, "example")).toBe(
      [
        specPath,
        "Status: done",
        `Hash: ${hash}`,
        "Events: 5",
        `Last event: ${ts}`,
        "",
        "lineage | latest assignment | state | repairs used",
        "a | a-fix | verified | 2",
        "b | b | blocked | 1",
        "c | c | pending | 0",
      ].join("\n"),
    );
  });
  it("renders each Done Criterion state and never shows unmet as passed", () => {
    const cwd = temporary();
    mkdirSync(join(cwd, SPECS_DIR), { recursive: true });
    writeFileSync(join(cwd, specPath), "Brief");
    appendSpecEvents(join(cwd, ".pi/specs/example.log.jsonl"), [
      {
        ...accepted,
        criteria: ["DC-1", "DC-2", "DC-3"],
        assignments: [
          { id: "a", dependencies: [], criteria: ["DC-1"] },
          { id: "b", dependencies: ["a"], criteria: ["DC-2"] },
          { id: "c", dependencies: [], criteria: ["DC-3"] },
        ],
      },
      { ...verified, criteria: [{ id: "DC-1", evidence: "one" }] },
      { ...blocked, repairCount: 1 },
    ]);
    expect(renderSpecStatus(cwd, "example")).toEndWith(
      [
        "",
        "criterion | state",
        "DC-1 | passed",
        "DC-2 | unmet",
        "DC-3 | pending",
      ].join("\n"),
    );
  });
});
