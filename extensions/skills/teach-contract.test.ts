import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("teach skill contract (wiring, not model adherence)", () => {
  const skill = read("skills/teach/SKILL.md");

  it("is read-only and gathers facts through how and why, not on its own", () => {
    expect(skill).toContain("Make no edits.");
    expect(skill).toContain("step 2 of the `investigation` Playbook");
    expect(skill).toContain("the `why` skill");
    expect(skill).toContain(
      "keep the `why` skill's evidence tier on each reason",
    );
  });

  it("answers small first and builds visuals up through showing-me", () => {
    expect(skill).toContain("Give the smallest complete answer first");
    expect(skill).toContain("apply the `showing-me` skill");
    expect(skill).toContain("each diagram redraws the last and adds one part");
  });

  it("is reached from /show-me, not its own alias", () => {
    expect(existsSync(join(root, "prompts/teach.md"))).toBe(false);
    expect(skill).toContain("This skill has no command of its own.");
    expect(read("skills/showing-me/SKILL.md")).toContain(
      "First argument `teach`: follow the `teach` skill",
    );
  });

  it("credits pstack", () => {
    expect(skill).toContain("Lauren Tan's MIT-licensed [pstack `teach` skill]");
  });
});
