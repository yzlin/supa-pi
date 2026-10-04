import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readSkill(): string {
  return readFileSync(
    join(process.cwd(), "skills", "plain-report", "SKILL.md"),
    "utf8",
  );
}

describe("plain-report skill contract", () => {
  it("defines the skill and its Final report and reviewer scope", () => {
    const skill = readSkill();

    expect(skill).toMatch(/^---\nname: plain-report\ndescription: .+\n/);
    expect(skill).toContain(
      "Use Plain report for Final reports and reviewer `why`/`change` text.",
    );
    expect(skill).toContain(
      "A Final report closes multi-step work: edits, investigations, delegated work, or review, diagnose, Wayfinder, and grill summaries.",
    );
    expect(skill.split("\n").length).toBeLessThan(60);
  });

  it("exempts chat and progress and respects voice and contract precedence", () => {
    const skill = readSkill();

    expect(skill).toContain(
      "Do not use Plain report for chat replies, one-line answers, lookups, or progress updates. Those stay terse and telegraphic.",
    );
    expect(skill).toContain(
      "When caveman mode is on, caveman voice overrides Plain report and the chat/progress style.",
    );
    expect(skill).toContain(
      "Higher-priority instructions, tested contracts, and required report structures take precedence",
    );
  });

  it("owns the compact paraphrased writing rules and glossary vocabulary", () => {
    const skill = readSkill();

    expect(skill).toContain("Write complete sentences with articles.");
    expect(skill).toContain(
      "20 words or fewer for instructions and 25 words or fewer for descriptions.",
    );
    expect(skill).toContain(
      "Keep one topic per sentence. In procedures, give one instruction per sentence.",
    );
    expect(skill).toContain(
      "Use active voice. Use the imperative for instructions.",
    );
    expect(skill).toContain("Use simple tenses.");
    expect(skill).toContain(
      "Give each term one meaning. Use the `CONTEXT.md` glossary terms when present.",
    );
    expect(skill).toContain("Do not swap synonyms for the same thing.");
    expect(skill).toContain("Avoid vague words and stacked noun phrases.");
    expect(skill).toContain("Limit each paragraph to six sentences.");
    expect(skill).toContain("Use numbered lists for ordered steps.");
  });

  it("prefers clarity at roughly 80% and preserves exact technical text", () => {
    const skill = readSkill();

    expect(skill).toContain("~80% ASD-STE100 Simplified Technical English");
    expect(skill).toContain(
      "Prefer clarity over strict compliance. Aim for ~80%",
    );
    expect(skill).toContain(
      "Do not apply STE dictionary limits to technical names.",
    );
    expect(skill).toContain(
      "Keep code, paths, commands, identifiers, quotes, and error text verbatim.",
    );
    expect(skill).toContain("These rules apply to surrounding prose only.");
  });

  it("leads with the conclusion and separates evidence from uncertainty", () => {
    const skill = readSkill();

    expect(skill).toContain("Lead with the conclusion.");
    expect(skill).toContain(
      "If a Final report needs user action, put the specific action and missing prerequisite before completed-work details.",
    );
    expect(skill).toContain(
      "Separate verified facts, inferences, and unknowns.",
    );
    expect(skill).toContain(
      "State what changed, the validation run, and what remains.",
    );
  });

  it("attributes the oversight idea and identifies the paraphrased source", () => {
    const skill = readSkill();

    expect(skill).toContain(
      "Andrej Karpathy's 2026-10-02 post on understanding LLM outputs.",
    );
    expect(skill).toContain(
      "ASD-STE100 is the ASD Simplified Technical English specification.",
    );
    expect(skill).toContain(
      "These rules are a paraphrased subset, not spec text.",
    );
    expect(skill).toContain(
      "No specification text or dictionary is copied here.",
    );
  });
});
