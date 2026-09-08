import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = readFileSync(
  join(import.meta.dir, "../../skills/execute/SKILL.md"),
  "utf8"
);
const executor = readFileSync(
  join(import.meta.dir, "../../agents/executor.md"),
  "utf8"
);

function expectInOrder(source: string, fragments: string[]): void {
  let cursor = -1;

  for (const fragment of fragments) {
    const index = source.indexOf(fragment, cursor + 1);
    expect(index, `Expected ordered fragment: ${fragment}`).toBeGreaterThan(
      cursor
    );
    cursor = index;
  }
}

function expectContracts(source: string, fragments: string[]): void {
  for (const fragment of fragments) {
    expect(source).toContain(fragment);
  }
}

describe("execute lifecycle contract", () => {
  it("has one ordered lifecycle followed by one outcome and recovery table", () => {
    expectInOrder(skill, [
      "## Ordered lifecycle",
      "1. Resolve",
      "2. Present",
      "3. Load",
      "4. Shape",
      "5. Dispatch",
      "6. Reconcile",
      "7. Recover",
      "8. Finish",
      "## Outcome and recovery",
      "| Outcome | Required handling |",
    ]);
    expect(skill.match(/## Ordered lifecycle/g)).toHaveLength(1);
    expect(skill.match(/## Outcome and recovery/g)).toHaveLength(1);
    expect(skill).not.toContain("### Automatic recovery");
    expect(skill).not.toContain("Execution loop:");
  });

  it("keeps plan, dispatch, TDD-shape, reference, and workspace safeguards", () => {
    expectContracts(skill, [
      "fixed template",
      "exact same string must be used for every checkpoint call",
      "whole `canonicalPlan`",
      "same `canonicalPlanHash`",
      "# Execution Brief",
      "ordered declaration of 2-6 operations",
      "exactly one distinct test target",
      "every test operation must precede every production operation",
      "if and only if `tdd` is exactly `true`",
      "resolve essential references",
      "never use unbounded home or global searches",
      "at most four bounded tasks per round",
      "exactly one report-only typed repair",
      "top-level `cwd`",
      "approve it instead of bypassing trust",
    ]);
  });

  it("keeps typed outcomes, independent verification, and baseline distinctions", () => {
    expectContracts(skill, [
      "invalidResult",
      "diagnostics, never as authority",
      "`repaired: true`",
      "`repaired: false`",
      "independently inspect",
      "run applicable diagnostics",
      "narrowest current test command",
      "request-caused failures",
      "unrelated pre-existing diagnostics",
      "mutation target order",
      "Persist that warning",
    ]);
  });

  it("keeps bounded local recovery and checkpoint identity semantics", () => {
    expectContracts(skill, [
      "at most two automatic recovery rounds per task",
      "Do not ask the user to approve recoverable local work",
      "separate non-TDD recovery Task",
      "Generated output discovered during a TDD Slice",
      "unfinished checkpoint exists for the same `canonicalPlan`",
      "Different-plan unfinished checkpoints remain untouched and unannounced",
      "Use `execute_checkpoint` for all checkpoint reads and writes",
      "index.json` maps `sha256(canonicalPlan)` to UUID as a repairable cache",
      "Legacy checkpoint files are ignored",
      "stop dependent work",
    ]);
  });

  it("separates independent verification from mutating retries and carries lineage budgets", () => {
    expectContracts(skill, [
      "new task IDs never reset the budget",
      "one verification pass per settled outcome",
      "non-TDD independent-verification recovery Task",
      "Preserve the original rejection",
      "never `invalidResult`",
      "Do not spend recovery rounds repeatedly mutating already-correct code to recreate RED",
      "continuation: {",
      "Before any intentional stop",
      "at most two continuation nudges",
      "Loads and older checkpoints do not arm it",
    ]);
  });

  it("keeps orchestration with the main session and execution with the worker", () => {
    expectContracts(skill, [
      "main-session orchestrator",
      "only the main session may add them",
      "Continue until all tasks are completed or terminally blocked",
      "Out of Scope",
    ]);
    expectContracts(executor, [
      "Execute exactly one assigned repository task",
      "Do not call task-management tools",
      "Put work the parent should schedule in `followUps`",
    ]);
  });
});
