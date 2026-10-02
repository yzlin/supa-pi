import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readRepositoryFile(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const reviewAgents = [
  "agents/code-reviewer.md",
  "agents/security-reviewer.md",
  "agents/performance-reviewer.md",
  "agents/database-reviewer.md",
  "agents/review-verifier.md",
  "agents/review-synthesizer.md",
];

describe("Plain report wiring contracts", () => {
  it("keeps telegraph scoped to global instructions, chat, and progress", () => {
    const globalAgents = readRepositoryFile("AGENTS.global.md");

    expect(globalAgents).toContain(
      "telegraph for global AGENTS, chat replies, progress updates",
    );
    expect(globalAgents).toContain(
      "Final reports after multi-step work follow `plain-report`",
    );
  });

  it("loads plain-report for closing reports but keeps other replies terse", () => {
    const corePrompt = readRepositoryFile("extensions/core-prompt/prompt.md");
    const output = corePrompt.split("<output>")[1]?.split("</output>")[0];

    expect(output).toContain(
      "For a Final report (the reply that closes multi-step work), load and follow the `plain-report` skill; other replies stay terse.",
    );
  });

  it("preserves wait-what's project vocabulary fallback", () => {
    const prompt = readRepositoryFile("prompts/wait-what.md");

    expect(prompt).toContain("Plain report style via the `plain-report` skill");
    expect(prompt).toContain(
      "use the ubiquitous language from `CONTEXT.md` when that file is present",
    );
    expect(prompt).toContain(
      "If `CONTEXT.md` is not present, re-pitch without it.",
    );
    expect(prompt).not.toContain("ASD-STE100");
  });

  it("applies Plain report to grill and Wayfinder decision summaries", () => {
    expect(readRepositoryFile("skills/grilling/SKILL.md")).toContain(
      "Write the pre-lock summary in Plain report style per the `plain-report` skill.",
    );
    expect(readRepositoryFile("skills/wayfinder/SKILL.md")).toContain(
      "Write the decision summary and handoff in Plain report style per the `plain-report` skill.",
    );
  });

  for (const path of reviewAgents) {
    it(`${path} applies Plain report to why/change prose`, () => {
      expect(readRepositoryFile(path)).toContain(
        "`why` and `change` prose in Plain report style per the `plain-report` skill.",
      );
    });
  }
});
