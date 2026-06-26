import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readGrillWithDocsPrompt(): string {
  return readFileSync(join(process.cwd(), "prompts", "grill-with-docs.md"), "utf8");
}

function expectPromptToContain(prompt: string, expectedText: string[]): void {
  for (const text of expectedText) {
    expect(prompt).toContain(text);
  }
}

describe("grill-with-docs prompt contract", () => {
  it("is a prompt-only command that composes grill-me with context-docs", () => {
    const prompt = readGrillWithDocsPrompt();

    expectPromptToContain(prompt, [
      "description:",
      'argument-hint: "-- <plan>"',
      "Command syntax: `/grill-with-docs -- <plan>`",
      "Use the `grill-me` skill behavior as canonical.",
      "Also use the `context-docs` skill behavior for durable project context.",
    ]);
  });

  it("requires docs-first preflight and only targeted code lookup", () => {
    const prompt = readGrillWithDocsPrompt();

    expectPromptToContain(prompt, [
      "Docs-first preflight: read existing context docs before grilling",
      "`CONTEXT.md`, `CONTEXT-MAP.md`, and relevant ADRs",
      "Inspect code only for targeted verification or resolvable questions",
      "If multiple contexts could apply and the target is ambiguous, ask one target-selection question before grilling.",
    ]);
  });

  it("keeps grill-me interview and final gate semantics", () => {
    const prompt = readGrillWithDocsPrompt();

    expectPromptToContain(prompt, [
      "Ask one question at a time.",
      "Use questionnaire rules inherited from `grill-me`.",
      "`Lock plan, stop here`",
      "`Keep grilling`",
      "The only final gate options are exactly `Lock plan, stop here` and `Keep grilling`.",
      "The final gate must not ask to implement, proceed, or start coding.",
    ]);
    expect(prompt).not.toContain("Yes, implement this contract");
    expect(prompt).not.toContain("implement this contract");
  });

  it("drafts docs during the interview but writes only allowed artifacts after lock", () => {
    const prompt = readGrillWithDocsPrompt();

    expectPromptToContain(prompt, [
      "Draft durable docs during the interview, but do not write files before the final lock.",
      "If the user chooses `Lock plan, stop here`, write the drafted docs immediately.",
      "`CONTEXT.md`",
      "`CONTEXT-MAP.md`",
      "ADRs",
      "Do not write any other durable artifacts.",
      "`CONTEXT.md` may contain domain/product facts, canonical language, constraints, and open questions.",
      "Create or update an ADR only when all are true: the decision is hard to reverse, surprising without context, and records a real tradeoff.",
      "If there is no durable content, write nothing and explain why.",
    ]);
  });
});
