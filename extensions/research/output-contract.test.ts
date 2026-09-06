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
      "Return the research brief in your response by default."
    );
    expect(role).toContain(
      "Write the brief only when the caller assigns an explicit output path."
    );
    expect(role).not.toContain("Write `research.md`");
    expect(command).toContain(
      "By default, request the research brief in the task result without assigning an output file."
    );
    expect(command).toContain("Research request: compare Bun and Node");
  });

  it("passes a user-requested output path through the task description", () => {
    const role = readResearcherRole();
    const command = buildResearchCommandMessage(
      "compare Bun and Node and write the report to docs/research/runtimes.md"
    );

    expect(role).toContain("Write to exactly that assigned path");
    expect(command).toContain(
      "When the user requests file output, assign the explicit output path in the task description"
    );
    expect(command).toContain(
      "Research request: compare Bun and Node and write the report to docs/research/runtimes.md"
    );
    expect(command).not.toContain("default output path");
  });

  it("requires distinct caller-assigned paths for requested parallel artifacts", () => {
    const command = buildResearchCommandMessage(
      "research Bun and Node as separate tracks; write Bun to reports/bun.md and Node to reports/node.md"
    );

    expect(command).toContain(
      "For multiple requested research tracks with file output, assign a distinct explicit output path to each task."
    );
    expect(command).toContain(
      "Research request: research Bun and Node as separate tracks; write Bun to reports/bun.md and Node to reports/node.md"
    );
    expect(command).not.toContain("auto-create output paths");
  });

  it("preserves brief sections, evidence rules, and task orchestration", () => {
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
    expect(command).toContain("Create exactly one task");
    expect(command).toContain("TaskCreate");
    expect(command).toContain("TaskExecute");
    expect(command).toContain("TaskOutput");
    expect(command).toContain('agentType: "researcher"');
    expect(command).toContain(
      "Put the full user request in the task description."
    );
    expect(command).toContain("cite factual claims");
  });
});
