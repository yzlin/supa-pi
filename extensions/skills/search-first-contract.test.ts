import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readSkill(name: string): string {
  return readFileSync(join(process.cwd(), "skills", name, "SKILL.md"), "utf8");
}

describe("search-first skill contract", () => {
  it("uses the supported main-session researcher route for material research", () => {
    const skill = readSkill("search-first");

    expect(skill).toContain("The main session owns research dispatch");
    expect(skill).toContain('Agent({\n  subagent_type: "researcher",');
    expect(skill).toContain('description: "Research existing solutions"');
    expect(skill).toContain("Give the researcher a concrete question");
    expect(skill).toContain(
      "Return: Structured comparison with recommendation",
    );
    expect(skill).not.toContain("Task(subagent_type=");
    expect(skill).not.toContain('subagent_type="general-purpose"');
  });

  it("keeps simple repository lookups direct and outside researcher dispatch", () => {
    const skill = readSkill("search-first");

    expect(skill).toContain(
      "For a simple local lookup, search the repository directly in the main session without launching a researcher",
    );
    expect(skill).toContain(
      "Does this already exist in the repo? → `rg` through relevant modules/tests first",
    );
    expect(skill).toContain(
      "Before creating a new utility, helper, or abstraction",
    );
  });

  it("checks cheap capabilities in order before external research", () => {
    const skill = readSkill("search-first");
    const checks = [
      "1. **Repository** —",
      "2. **Stdlib** —",
      "3. **Native platform** —",
      "4. **Already-installed dependency** —",
    ];
    const positions = checks.map((check) => skill.indexOf(check));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
    expect(skill).toContain(
      "If a suitable existing capability meets those requirements, stop and use or reuse it",
    );
    expect(skill).toContain("Before external package/web research");
  });

  it("keeps requirement safeguards and justified research in every route", () => {
    const skill = readSkill("search-first");

    for (const requirement of [
      "safety",
      "correctness",
      "accessibility",
      "edge cases",
    ]) {
      expect(skill).toContain(requirement);
    }
    expect(skill).toContain(
      "A justified package or research remains appropriate when these checks do not meet the requirements",
    );
    expect(skill).toContain(
      "For non-trivial functionality, run the cheap capability check and relevant local skill/MCP checks first.",
    );
    expect(skill).toContain("Local checks already completed: [FINDINGS]");
    expect(skill).toContain(
      "do not choose a shorter implementation without checking fit",
    );
  });
});
