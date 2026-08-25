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

  it("conditionally composes domain modeling without making it always-on", () => {
    const skill = readRepositoryFile("skills", "grilling", "SKILL.md");

    for (const text of [
      "Load and follow `domain-modeling` only when",
      "fuzzy or disputed terms",
      "domain claims that need scenario testing",
      "code and durable docs conflict",
      "ownership, integration, lifecycle, or trust boundaries are unclear",
      "possible ADR candidacy",
      "Use its completed packet to guide subsequent interview questions",
    ]) {
      expect(skill).toContain(text);
    }
    expect(skill).toContain("Do not load it for every interview");
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

describe("context-docs composition contract", () => {
  it("delegates semantic analysis only for explicit domain signals", () => {
    const skill = readRepositoryFile("skills", "context-docs", "SKILL.md");

    for (const text of [
      "Delegate semantic analysis to `domain-modeling`",
      "vocabulary",
      "scenario-dependent domain claims",
      "code and durable docs contradict",
      "real ownership, integration, lifecycle, or trust boundaries",
      "possible ADR candidacy",
      "completed domain-modeling packet",
      "consume it without invoking `domain-modeling` again",
      "sole persistence authority",
    ]) {
      expect(skill).toContain(text);
    }
  });

  it("persists canonical terms and handles canonical ADR results", () => {
    const skill = readRepositoryFile("skills", "context-docs", "SKILL.md");

    for (const text of [
      "canonical term, its concise definition, and its `_Avoid_` aliases",
      "all three canonical results are `yes`",
      "any result is `unknown`",
      "ask one focused question",
      "any result is `no`",
      "refuse to write the ADR and explain why",
    ]) {
      expect(skill).toContain(text);
    }
  });
});

describe("grill-me wrapper contract", () => {
  it("is explicit, discoverable, and composes the canonical skills", () => {
    const skill = readRepositoryFile("skills", "grill-me", "SKILL.md");

    expect(skill).toContain("Explicit /grill-me wrapper");
    expect(skill).toContain("Use only when the user invokes /grill-me");
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
    const skill = readRepositoryFile("skills", "grill-me", "SKILL.md");

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
    const skill = readRepositoryFile("skills", "grill-me", "SKILL.md");

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
      "ADR qualification through the canonical `context-docs` and `domain-modeling` skills",
      "Do not duplicate the ADR qualification gate here",
      "If the interview produces no durable content, write nothing",
      "`Lock plan, stop here`",
      "`Keep grilling`",
    ]) {
      expect(skill).toContain(text);
    }
  });
});

describe("semantic ownership contract", () => {
  it("keeps literal ADR criteria solely in domain-modeling", () => {
    const contextDocs = readRepositoryFile(
      "skills",
      "context-docs",
      "SKILL.md"
    );
    const grilling = readRepositoryFile("skills", "grilling", "SKILL.md");
    const grillMe = readRepositoryFile("skills", "grill-me", "SKILL.md");

    for (const skill of [contextDocs, grilling, grillMe]) {
      expect(skill).not.toContain("hard to reverse");
      expect(skill).not.toContain("surprising without context");
      expect(skill).not.toContain("real tradeoff");
    }
  });
});

describe("grill-me command contract", () => {
  it("keeps a thin prompt-pipeline wrapper around the canonical skill", () => {
    const extension = readRepositoryFile(
      "extensions",
      "prompt-commands",
      "index.ts"
    );

    expect(extension).toContain('"grill-me": {');
    const prompt = readRepositoryFile("prompts", "grill-me.md");
    expect(prompt).toContain('argument-hint: "<plan>"');
    expect(prompt).toContain(
      "Use the `grill-me` wrapper skill as canonical for this explicit command."
    );
    expect(prompt).toContain("Plan:\n$@");
    expect(extension).toContain(
      "Use the `grill-me` wrapper skill as canonical for this explicit command."
    );
    expect(extension).toContain('pi.on("input"');
    expect(extension).not.toContain("registerCommand");
    expect(extension).not.toContain("`grilling` skill");
    expect(extension).not.toContain("CONTEXT.md");
    expect(extension).not.toContain("questionnaire");
  });
});
