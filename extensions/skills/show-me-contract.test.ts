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
      "If the first argument after any depth word is `text`, `diagram`, or `html`, render at that Explainer rung.",
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

  it("keeps the topic argument hint on the /show-me prompt template", () => {
    const prompt = readRepositoryFile("prompts", "show-me.md");
    expect(prompt).toContain(
      'argument-hint: "[teach|quick] [text|diagram|html] [topic]"',
    );
  });

  it("escalates /show-me to teach by depth, never for skill callers", () => {
    const depth = readSkill("showing-me")
      .split("## Depth")[1]
      ?.split("\n## ")[0];

    expect(depth).toContain("First argument `teach`: follow the `teach` skill");
    expect(depth).toContain(
      "First argument `quick`: skip the `teach` skill; read only what the view itself needs.",
    );
    expect(depth).toContain(
      "when this session has not read the topic's code, or when the request asks how or why",
    );
    expect(depth).toContain(
      "When another skill or Playbook step applies this skill, never escalate.",
    );
    expect(depth).toContain(
      "open the reply with two lines before any tool call: `Understood: <the question in your words>` and `Path: teach|quick — <the reason>`.",
    );
    expect(readSkill("showing-me")).toContain(
      "When the `teach` skill applies this skill, its diagram series overrides",
    );
  });

  it("keeps architecture diagrams proportional to the question", () => {
    const skill = readSkill("architecture-diagrams");

    expect(skill).toContain("Choose the smallest diagram set");
    expect(skill).toContain(
      "An architectural visual or diagram is explicitly requested.",
    );
    expect(skill).toContain("An architectural visual is needed");
    expect(skill).toContain("- State diagrams:");
    expect(skill).toContain("not by a variable name");
    expect(skill).toContain("suggest `/statechart`");
  });
});
