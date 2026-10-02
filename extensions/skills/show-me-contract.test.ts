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

  it("supports explicit Explainer rungs and latest-result fallback", () => {
    const skill = readSkill("showing-me");

    expect(skill).toContain("## Explainer Ladder");
    expect(skill).toContain(
      "If the first argument is `text`, `diagram`, or `html`, render at that Explainer rung.",
    );
    expect(skill).toContain(
      "Otherwise, keep the existing smallest-useful choice.",
    );
    expect(skill).toContain(
      "If no topic follows, re-render the latest result in this session.",
    );
    expect(skill).toContain(
      "`text`: Plain report prose per the `plain-report` skill; the same rung as `/wait-what`.",
    );
    expect(skill).toContain(
      "`diagram`: Use the existing views table for trees, pseudocode, focused diffs, or Mermaid via `architecture-diagrams`; do not choose HTML at this rung.",
    );
    expect(skill).toContain(
      "`html`: Use the `glimpse` skill to create one discardable Glimpse explainer under `$TMPDIR/supa-pi-show-me/`, never in the repository.",
    );
    expect(skill).toContain("Video is not a rung; it is deferred.");
  });

  it("keeps HTML temporary and explicit requests above the default", () => {
    const skill = readSkill("showing-me");
    const richVisuals = skill.split("## Rich Visuals")[1];

    expect(richVisuals).toContain("show it through Glimpse");
    expect(richVisuals).toContain(
      "Write HTML explainers under `$TMPDIR/supa-pi-show-me/`, never in the repository.",
    );
    expect(richVisuals).toContain(
      "Do not create HTML for a simple code or control-flow explanation.",
    );
    expect(richVisuals).toContain(
      "An explicit `html` request overrides this default.",
    );
  });

  it("keeps /show-me as a thin prompt-pipeline showing-me wrapper", () => {
    const extension = readRepositoryFile(
      "extensions",
      "prompt-commands",
      "index.ts",
    );

    expect(extension).toContain('"show-me": {');
    const prompt = readRepositoryFile("prompts", "show-me.md");
    expect(prompt).toContain('argument-hint: "[text|diagram|html] [topic]"');
    expect(prompt).toContain(
      "Use the `showing-me` skill as canonical for this explicit command.",
    );
    expect(prompt).toContain("Topic:\n$@");
    expect(extension).toContain(
      "Use the `showing-me` skill as canonical for this explicit command.",
    );
    expect(extension).toContain('pi.on("input"');
    expect(extension).not.toContain("registerCommand");
    expect(extension).not.toContain("component tree");
    expect(extension).not.toContain("Mermaid");
  });

  it("keeps architecture diagrams proportional to the question", () => {
    const skill = readSkill("architecture-diagrams");

    expect(skill).toContain("Choose the smallest diagram set");
    expect(skill).toContain(
      "An architectural visual or diagram is explicitly requested.",
    );
    expect(skill).toContain("An architectural visual is needed");
    expect(skill).not.toContain(
      '"diagram", "architecture", or "system design" mentioned',
    );
    expect(skill).not.toContain(
      "For every architectural assessment, create the following diagrams",
    );
    expect(skill).not.toContain("use `show-me`");
  });
});
