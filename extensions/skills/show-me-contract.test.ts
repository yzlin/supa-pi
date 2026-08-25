import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readRepositoryFile(...path: string[]): string {
  return readFileSync(join(process.cwd(), ...path), "utf8");
}

function readSkill(name: string): string {
  return readRepositoryFile("skills", name, "SKILL.md");
}

describe("visual explanation skill contracts", () => {
  it("offers focused visual shapes through showing-me", () => {
    const skill = readSkill("showing-me");

    expect(skill).toContain("name: showing-me");
    expect(skill).toContain("Use only when the user explicitly asks");
    expect(skill).toContain("Pick one view by default");
    expect(skill).toContain("pseudocode");
    expect(skill).toContain("call tree");
    expect(skill).toContain("component tree");
    expect(skill).toContain("shallow file tree");
    expect(skill).toContain("focused diff");
    expect(skill).toContain("Glimpse");
  });

  it("keeps /show-me as a thin prompt-pipeline showing-me wrapper", () => {
    const extension = readRepositoryFile(
      "extensions",
      "prompt-commands",
      "index.ts"
    );

    expect(extension).toContain('"show-me": {');
    const prompt = readRepositoryFile("prompts", "show-me.md");
    expect(prompt).toContain('argument-hint: "[topic]"');
    expect(prompt).toContain(
      "Use the `showing-me` skill as canonical for this explicit command."
    );
    expect(prompt).toContain("Topic:\n$@");
    expect(extension).toContain(
      "Use the `showing-me` skill as canonical for this explicit command."
    );
    expect(extension).toContain('pi.on("input"');
    expect(extension).not.toContain("registerCommand");
    expect(extension).not.toContain("component tree");
    expect(extension).not.toContain("Mermaid");
  });

  it("keeps architecture diagrams proportional to the question", () => {
    const skill = readSkill("architecture-diagrams");

    expect(skill).toContain("Choose the smallest diagram set");
    expect(skill).not.toContain(
      "For every architectural assessment, create the following diagrams"
    );
    expect(skill).not.toContain("use `show-me`");
  });
});
