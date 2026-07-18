import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readRepositoryFile(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8");
}

describe("grill-with-docs wrapper contract", () => {
  it("is explicit, discoverable, and composes the canonical skills", () => {
    const skill = readRepositoryFile("skills", "grill-with-docs", "SKILL.md");

    expect(skill).toContain("Explicit /grill-with-docs wrapper");
    expect(skill).toContain("Use only when the user invokes /grill-with-docs");
    expect(skill).toContain(
      "Load and follow the `grilling` skill as the canonical interview primitive."
    );
    expect(skill).toContain(
      "Load and follow the `context-docs` skill as the canonical durable-context contract."
    );
    expect(skill).not.toContain("disable-model-invocation");
    expect(skill).not.toContain("exactly one single-select question per call");
    expect(skill).not.toContain("## Risk Taxonomy");
  });

  it("owns docs-first targeting and targeted code verification", () => {
    const skill = readRepositoryFile("skills", "grill-with-docs", "SKILL.md");

    for (const text of [
      "docs-first preflight",
      "`CONTEXT.md`, `CONTEXT-MAP.md`, and relevant ADRs",
      "Inspect code only for targeted verification",
      "ask exactly one target-selection question before grilling",
    ]) {
      expect(skill).toContain(text);
    }
  });

  it("drafts without writes, then immediately writes only qualifying docs after lock", () => {
    const skill = readRepositoryFile("skills", "grill-with-docs", "SKILL.md");

    for (const text of [
      "Draft durable content during the interview",
      "do not write any file before",
      "immediately write any qualifying drafted content",
      "`CONTEXT.md`",
      "`CONTEXT-MAP.md`",
      "qualifying ADRs",
      "narrow allowed-write list overrides the broader destinations available in normal `context-docs` workflows",
      "Continue to follow all other `context-docs` requirements, including its context and ADR semantics",
      "domain or product facts, canonical language, constraints, and open questions",
      "hard to reverse, surprising without context, and records a real tradeoff",
      "If the interview produces no durable content, write nothing",
      "`Lock plan, stop here`",
      "`Keep grilling`",
    ]) {
      expect(skill).toContain(text);
    }
  });
});

describe("grill-with-docs prompt contract", () => {
  it("uses simple plan syntax and delegates only to its wrapper", () => {
    const prompt = readRepositoryFile("prompts", "grill-with-docs.md");

    expect(prompt).toContain('argument-hint: "<plan>"');
    expect(prompt).toContain(
      "Use the `grill-with-docs` wrapper skill as canonical for this explicit command."
    );
    expect(prompt).toContain("$@");
    expect(prompt).not.toContain(" -- ");
    expect(prompt).not.toContain("`grilling` skill");
    expect(prompt).not.toContain("CONTEXT.md");
    expect(prompt).not.toContain("questionnaire");
  });
});
