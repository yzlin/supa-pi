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
      "Return: Structured comparison with recommendation"
    );
    expect(skill).not.toContain("Task(subagent_type=");
    expect(skill).not.toContain('subagent_type="general-purpose"');
  });

  it("has the main session hand researcher findings to restricted workers", () => {
    const skill = readSkill("search-first");

    expect(skill).toContain(
      "The main session supplies relevant researcher findings to the planner"
    );
    expect(skill).toContain(
      "The main session supplies relevant researcher findings to the architect"
    );
    expect(skill).not.toContain("The planner should invoke researcher");
    expect(skill).not.toContain("The architect should consult researcher");
  });

  it("keeps simple repository lookups direct and outside researcher dispatch", () => {
    const skill = readSkill("search-first");

    expect(skill).toContain(
      "For a simple local lookup, search the repository directly in the main session without launching a researcher"
    );
    expect(skill).toContain(
      "Does this already exist in the repo? → `rg` through relevant modules/tests first"
    );
    expect(skill).toContain(
      "Before creating a new utility, helper, or abstraction"
    );
  });
});
