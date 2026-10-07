import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildResearchCommandMessage } from "./index";

function readResearcherRole(): string {
  return readFileSync(join(process.cwd(), "agents", "researcher.md"), "utf8");
}

describe("research output ownership contract", () => {
  it("returns the brief in the response by default without an implicit file", () => {
    const role = readResearcherRole();
    const command = buildResearchCommandMessage("compare Bun and Node");

    expect(role).toContain(
      "Return the research brief in your response by default.",
    );
    expect(role).toContain(
      "Write the brief only when the caller assigns an explicit output path.",
    );
    expect(role).not.toContain("Write `research.md`");
    expect(command).toContain(
      "By default, request the research brief in the child report without assigning an output file.",
    );
    expect(command).toContain("Research request: compare Bun and Node");
  });

  it("passes a user-requested output path through the child task", () => {
    const role = readResearcherRole();
    const command = buildResearchCommandMessage(
      "compare Bun and Node and write the report to docs/research/runtimes.md",
    );

    expect(role).toContain("Write to exactly that assigned path");
    expect(command).toContain(
      "When the user requests file output, assign the explicit output path in the child task",
    );
    expect(command).toContain(
      "Research request: compare Bun and Node and write the report to docs/research/runtimes.md",
    );
    expect(command).not.toContain("default output path");
  });

  it("requires distinct caller-assigned paths for requested parallel artifacts", () => {
    const command = buildResearchCommandMessage(
      "research Bun and Node as separate tracks; write Bun to reports/bun.md and Node to reports/node.md",
    );

    expect(command).toContain(
      "For multiple requested research tracks with file output, assign a distinct explicit output path to each child.",
    );
    expect(command).toContain(
      "Research request: research Bun and Node as separate tracks; write Bun to reports/bun.md and Node to reports/node.md",
    );
    expect(command).not.toContain("auto-create output paths");
  });

  it("preserves brief sections, evidence rules, and blocking delegation", () => {
    const role = readResearcherRole();
    const command = buildResearchCommandMessage("verify runtime support");

    for (const heading of [
      "# Research: [topic]",
      "## Summary",
      "## Findings",
      "## Sources",
      "## Gaps",
    ]) {
      expect(role).toContain(heading);
    }
    expect(role).toContain("Distinguish sourced facts from inference");
    expect(command).toContain("exactly one blocking subagent call");
    expect(command).toContain('subagent({agent: "researcher", task})');
    expect(command).toContain(
      "Put the full user request and evidence constraints in the child task.",
    );
    expect(command).toContain(
      "Children are fresh and do not inherit the parent conversation.",
    );
    expect(command).toContain("Wait for the child report before answering.");
    expect(command).not.toMatch(
      /TaskCreate|TaskExecute|TaskOutput|agentType|pi-tasks/,
    );
    expect(command).toContain("cite factual claims");
  });
});

describe("research unavailable delegation contract", () => {
  it("discloses genuine tool unavailability and preserves the full request, evidence, and file ownership in main", () => {
    const command = buildResearchCommandMessage(
      "verify runtime support and write the report to reports/runtime.md",
    );

    expect(command).toContain(
      "Do not perform the research directly in the main session unless the delegation tool itself is genuinely unavailable.",
    );
    expect(command).toContain(
      "If the delegation tool itself is genuinely unavailable, explicitly disclose that and conduct the requested research in the main session.",
    );
    expect(command).toContain(
      "Use the full user request and the same strict evidence and file ownership requirements above",
    );
    expect(command).toContain(
      "return the brief without a file by default, write only to caller-assigned paths, and keep parallel writes disjoint.",
    );
    expect(command).toContain(
      "Research request: verify runtime support and write the report to reports/runtime.md",
    );
    expect(command).toContain("do not guess");
    expect(command).toContain("cite factual claims");
    expect(command).toContain("prefer primary or official sources");
    expect(command).toContain("separate verified facts from inference");
    expect(command).toContain("surface open uncertainties");
    expect(command).not.toContain(
      "Do not perform main-session research as an automatic fallback.",
    );
  });

  it("fails closed on named-role launch failures rather than treating them as missing-tool fallback", () => {
    const command = buildResearchCommandMessage("verify runtime support");

    expect(command).toContain(
      "Failure to launch the named researcher role is not tool unavailability",
    );
    for (const failure of [
      "unknown, malformed, untrusted, or blocked role",
      "missing role model authentication",
      "scope or resource restrictions",
    ]) {
      expect(command).toContain(failure);
    }
    expect(command).toContain(
      "report the exact blocker and do not fall back to main-session research.",
    );
    expect(command).toContain(
      "Do not bypass trust, substitute a generic or different role, silently change models, or invent results or file paths.",
    );
  });
});
