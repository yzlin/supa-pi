import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readRepositoryFile(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8");
}

describe("grilling skill contract", () => {
  it("owns natural discovery and the shared interview semantics", () => {
    const skill = readRepositoryFile("skills", "grilling", "SKILL.md");

    for (const text of [
      "name: grilling",
      '"grill me"',
      "plans, decisions, and ideas",
      "decision tree",
      "Discover facts from the environment instead of asking the user",
      "The user owns every decision",
      "Do not act on the plan or make implementation changes before the user confirms the final lock",
      "Ask exactly one question at a time",
      "exactly one single-select question per call",
      "Add `preview` to every caller-supplied option",
      "Prefix the recommended option label with `Recommend:`",
      "Never re-ask an answered question",
      "highest-leverage unresolved question",
      "## Risk Taxonomy",
    ]) {
      expect(skill).toContain(text);
    }
  });

  it("keeps the final gate stop-only and never implementation-oriented", () => {
    const skill = readRepositoryFile("skills", "grilling", "SKILL.md");

    expect(skill).toContain("`Lock plan, stop here`");
    expect(skill).toContain("`Keep grilling`");
    expect(skill).toContain("injected custom row for `Type something.`");
    expect(skill).toContain(
      "must not ask whether to proceed to implementation"
    );
    expect(skill).toContain(
      "must not include any implement/proceed/start-coding wording or option"
    );
    expect(skill).not.toContain("Yes, implement this contract");
  });
});

describe("grill-me wrapper and prompt contract", () => {
  it("keeps the wrapper narrow and explicit", () => {
    const wrapper = readRepositoryFile("skills", "grill-me", "SKILL.md");

    expect(wrapper).toContain("Explicit /grill-me wrapper");
    expect(wrapper).toContain("Use only when the user invokes /grill-me");
    expect(wrapper).toContain("follow the `grilling` skill as canonical");
    expect(wrapper).not.toContain('"stress-test this"');
    expect(wrapper).not.toContain("## Risk Taxonomy");
    expect(wrapper).not.toContain("disable-model-invocation");
  });

  it("uses simple plan syntax and delegates only to its wrapper", () => {
    const prompt = readRepositoryFile("prompts", "grill-me.md");

    expect(prompt).toContain('argument-hint: "<plan>"');
    expect(prompt).toContain(
      "Use the `grill-me` wrapper skill as canonical for this explicit command."
    );
    expect(prompt).toContain("$@");
    expect(prompt).not.toContain(" -- ");
    expect(prompt).not.toContain("`grilling` skill");
    expect(prompt).not.toContain("questionnaire");
  });
});
