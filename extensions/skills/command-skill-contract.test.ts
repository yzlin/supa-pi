import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readSkill(name: string): string {
  return readFileSync(join(process.cwd(), "skills", name, "SKILL.md"), "utf8");
}

describe("skill-backed command contracts", () => {
  it("keeps /review static orchestration rules in review-orchestration skill", () => {
    const skill = readSkill("review-orchestration");

    expect(skill).toContain("review_run({runId})");
    expect(skill).toContain("review_finalize({runId})");
    expect(skill).not.toContain("SubagentWorkflow");
    expect(skill).toContain("## Reviewer Coverage");
  });

  it("keeps /review-fix static delegation rules in review-fix skill", () => {
    const skill = readSkill("review-fix");

    expect(skill).toContain('subagent({agent: "executor", task:');
    expect(skill).toContain("exactly one blocking");
    expect(skill).toContain("structuredOutput");
    expect(skill).toContain("independently inspect");
    expect(skill).not.toContain("subagent_type");
    expect(skill).not.toContain("max_turns");
    expect(skill).toContain("The main session is forbidden from editing code");
    expect(skill).toContain("do not call an executor subagent");
    expect(skill).toContain("Do not fall back to main-session fixing");
    expect(skill).toContain("children do not inherit parent conversation");
    expect(skill).toContain("this does not authorize `/execute` or its ledger");
    expect(skill).toContain(
      "Return the existing executor JSON schema unchanged",
    );
    expect(skill).toContain(
      "report the typecheck as executor-reported, not independently verified",
    );
    expect(skill).toContain("List executor-reported checks separately");
    expect(skill).toContain(
      "Record each check in `validation` as the exact command plus pass/fail",
    );
    expect(skill).toContain(
      "Run the project typecheck after your final edit when touched code is typed; rerun it if you edit again after it passes.",
    );
    expect(skill).toContain(
      "record a baseline with `git status --porcelain --untracked-files=all`",
    );
    expect(skill).toContain(
      "files changed since the baseline are missing from the executor's `filesTouched`",
    );
  });

  it("keeps /simplify main-session edit-boundary rules in simplify skill", () => {
    const skill = readSkill("simplify");

    expect(skill).toContain(
      "Work in the main session; do not delegate this task.",
    );
    expect(skill).not.toContain("subagent(");
    expect(skill).not.toContain("code-simplifier");
    expect(skill).not.toContain("max_turns");
    expect(skill).toContain(
      "Do not edit ignored lockfiles or unsupported changed files",
    );
    expect(skill).toContain("retry once with the failure named");
    expect(skill).toContain(
      "Before editing, record a baseline without modifying the working tree: run `git status --porcelain --untracked-files=all`",
    );
    expect(skill).toContain(
      "run `git status --porcelain --untracked-files=all` for detection only, then copy every editable file to a temp directory outside the repo",
    );
    expect(skill).toContain(
      "record `git hash-object <path>` for each path that status lists outside editable files",
    );
    expect(skill).not.toContain(
      "copy every editable file plus every path that status lists as changed or untracked",
    );
    expect(skill).toContain(
      "If the run has no `Editable files` list, first resolve the recent-session files named by the focus instruction and write that list down.",
    );
    expect(skill).toContain(
      "That list is the edit boundary for the baseline and the Audit",
    );
    expect(skill).toContain("scoped and recent-session runs");
    expect(skill).toContain(
      "rerun the same status, rehash those paths, and diff editable files against their saved copies",
    );
    expect(skill).toContain(
      "Any path outside editable files whose status line changed or whose hash differs from the baseline is a scope escape: report those paths for the user",
    );
    expect(skill).toContain(
      "never revert, restore, or trash paths outside editable files",
    );
    expect(skill).toContain(
      "Keep license headers; non-obvious behavior forced by an external dependency, platform, vendor, or protocol; doc comments that define a public API contract; and issue or RFC links for constraints code cannot express.",
    );
    expect(skill).not.toContain("workarounds forced by");
    expect(skill).toContain(
      "restore each saved copy inside editable files and move editable paths noted as not existing to Trash with `trash`",
    );
    expect(skill).not.toContain("`git restore -- <path>` is allowed");
    expect(skill).toContain("from the restored baseline");
    expect(skill).toContain(
      "Never use `git checkout`, `git restore`, `git reset`, or `git stash` push/pop/apply to revert /simplify results",
    );
    // Craft safeguards moved from the retired code-simplifier agent.
    expect(skill).toContain(
      "Within the assigned scope, consider replacing an in-scope custom mechanism",
    );
    expect(skill).toContain(
      "Do not widen editable files for it; if another file or new package research is needed, stop and report it.",
    );
    expect(skill).toContain("Never reword a justification into a shorter one.");
    expect(skill).toContain("look up the suppressed rule");
    expect(skill).toContain("A reshape flag names the exact symbol");
    expect(skill).toContain(
      "Treat unused-code tool output as evidence, not proof.",
    );
  });
});

it("executor preserves a detached report-only boundary and model route", () => {
  const role = readFileSync(
    join(process.cwd(), "agents", "executor.md"),
    "utf8",
  );
  expect(role).toContain("model: claude-code/claude-opus-5-5");
  expect(role).toContain("thinking: high");
  expect(role).toContain("extensions: false");
  expect(role).toContain("skills: false");
  expect(role).toContain(
    "Do not call `execute_checkpoint` or `goal_checkpoint`",
  );
  expect(role).toContain("no parent conversation is inherited");
  expect(role).toContain("internal `StructuredOutput`");
  expect(role).toContain("main owns independent verification and completion");
  expect(role).not.toContain("SubagentWorkflow");
  expect(role).not.toContain("pi-tasks");
});
