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
  });

  it("keeps /simplify static edit-boundary rules in simplify skill", () => {
    const skill = readSkill("simplify");

    expect(skill).toContain("Delegate to `code-simplifier`");
    expect(skill).toContain('subagent({agent: "code-simplifier", task:');
    expect(skill).toContain("self-contained");
    expect(skill).not.toContain("max_turns");
    expect(skill).not.toContain("Agent call");
    expect(skill).toContain(
      "Do not edit ignored lockfiles or unsupported changed files",
    );
  });
});

it("executor preserves a detached report-only boundary and model route", () => {
  const role = readFileSync(
    join(process.cwd(), "agents", "executor.md"),
    "utf8",
  );
  expect(role).toContain("model: openai-codex/gpt-6.1-sol");
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
