import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readSkill(name: string): string {
  return readFileSync(join(process.cwd(), "skills", name, "SKILL.md"), "utf8");
}

describe("skill-backed command contracts", () => {
  it("keeps /review static orchestration rules in review-orchestration skill", () => {
    const skill = readSkill("review-orchestration");

    expect(skill).toContain("When delegating via the Agent tool, omit `max_turns`");
    expect(skill).toContain("Do not use pi task tools");
    expect(skill).toContain("## Reviewer Coverage");
  });

  it("keeps /review-fix static delegation rules in review-fix skill", () => {
    const skill = readSkill("review-fix");

    expect(skill).toContain('subagent_type: "executor"');
    expect(skill).toContain("The main session is forbidden from editing code");
    expect(skill).toContain("Return the existing executor JSON schema unchanged");
  });

  it("keeps /simplify static edit-boundary rules in simplify skill", () => {
    const skill = readSkill("simplify");

    expect(skill).toContain("Delegate to `code-simplifier`");
    expect(skill).toContain("Do not set `max_turns`");
    expect(skill).toContain("Do not edit ignored lockfiles or unsupported changed files");
  });
});
