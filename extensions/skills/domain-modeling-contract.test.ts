import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skillPath = join(process.cwd(), "skills", "domain-modeling", "SKILL.md");

function readSkill(): string {
  return readFileSync(skillPath, "utf8");
}

function readRepositoryFile(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8");
}

describe("domain-modeling skill contract", () => {
  it("is the canonical, selectively activated semantic primitive", () => {
    const skill = readSkill();

    for (const text of [
      "name: domain-modeling",
      "canonical semantic primitive",
      "standalone",
      "delegated",
      "not always-on",
      "Own vocabulary sharpening",
    ]) {
      expect(skill).toContain(text);
    }
  });

  it("requires grounded terms, scenarios, contradictions, and boundaries", () => {
    const skill = readSkill();

    for (const text of [
      "canonical term",
      "concise definition",
      "_Avoid_",
      "actor",
      "action",
      "boundary",
      "outcome",
      "code and durable docs",
      "surface the contradiction",
      "ownership",
      "integration",
      "lifecycle",
      "trust boundary",
      "targeted evidence",
      "secrets",
      "raw private data",
    ]) {
      expect(skill).toContain(text);
    }
  });

  it("qualifies ADRs only when all three explicit tests are yes", () => {
    const skill = readSkill();

    for (const text of [
      "hard to reverse: yes | no | unknown",
      "surprising without context: yes | no | unknown",
      "real tradeoff: yes | no | unknown",
      "All three must be `yes`",
    ]) {
      expect(skill).toContain(text);
    }
  });

  it("uses exactly five output sections with concise empty states", () => {
    const skill = readSkill();
    const headings = skill.match(/^## .+$/gm);

    expect(headings).toEqual([
      "## Resolved terms",
      "## Scenarios",
      "## Contradictions",
      "## Boundaries",
      "## ADR candidacy",
    ]);
    expect(skill).toContain("Use the concise empty state");
  });

  it("lets the caller contract govern delegated interaction and output", () => {
    const skill = readSkill();
    const grilling = readRepositoryFile("skills", "grilling", "SKILL.md");
    const contextDocs = readRepositoryFile(
      "skills",
      "context-docs",
      "SKILL.md"
    );

    expect(skill).toContain(
      "final user-facing response only for standalone domain-modeling runs"
    );
    expect(skill).toContain("internal caller consumption");
    expect(skill).toContain(
      "caller skill governs interaction, writes, and final user-facing output"
    );
    expect(skill).not.toContain("Output always uses exactly");
    expect(grilling).toContain("Ask exactly one question at a time");
    expect(contextDocs).toContain(
      "Summarize files read, files changed, decisions captured, open questions, and validation performed."
    );
  });

  it("hands persistence packets one-way to context-docs", () => {
    const skill = readSkill();

    for (const text of [
      "does not directly write durable docs",
      "direct request asks for persistence",
      "completed packet",
      "delegate it to `context-docs`",
      "invoked by `context-docs`",
      "analysis only",
      "never delegate back",
    ]) {
      expect(skill).toContain(text);
    }
  });

  it("attributes the pinned MIT source", () => {
    const skill = readSkill();

    expect(skill).toContain("Matt Pocock");
    expect(skill).toContain("MIT");
    expect(skill).toContain(
      "https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/skills/engineering/domain-modeling/SKILL.md"
    );
  });
});
