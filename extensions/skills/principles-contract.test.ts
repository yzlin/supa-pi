import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const principleDir = join(root, "rules", "principles");
const playbookDir = join(root, "skills", "supapi-mode", "playbooks");
const PRINCIPLES = [
  "attack-the-premise",
  "boundary-discipline",
  "build-the-lever",
  "encode-lessons-in-structure",
  "explain-the-number",
  "fix-root-causes",
  "foundational-thinking",
  "guard-the-context-window",
  "laziness-protocol",
  "make-operations-idempotent",
  "migrate-callers-then-delete-legacy-apis",
  "minimize-reader-load",
  "model-the-domain",
  "never-block-on-the-human",
  "outcome-oriented-execution",
  "prove-it-works",
  "redesign-from-first-principles",
  "search-first",
  "sequence-verifiable-units",
  "subtract-before-you-add",
  "test-behavior-not-implementation",
  "type-system-discipline",
];

function principle(name: string): string {
  return readFileSync(join(principleDir, `${name}.md`), "utf8");
}

describe("principles contract (wiring, not model adherence)", () => {
  it("ships exactly the approved one-rule-per-file set", () => {
    const files = readdirSync(principleDir)
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.replace(/\.md$/u, ""));
    expect(files.toSorted()).toEqual(PRINCIPLES);
  });

  it("gives each principle a title and an Apply-when trigger, no frontmatter", () => {
    for (const name of PRINCIPLES) {
      const text = principle(name);
      expect(text.startsWith("# ")).toBe(true);
      expect(text).toMatch(/^Apply when: .+$/mu);
    }
  });

  it("credits pstack under its MIT license except the ECC-origin search-first", () => {
    expect(
      readFileSync(join(principleDir, "LICENSE.upstream"), "utf8"),
    ).toContain("Copyright (c) 2026 Lauren Tan");
    for (const name of PRINCIPLES.filter((n) => n !== "search-first")) {
      expect(principle(name)).toContain(
        `Lauren Tan's MIT-licensed [pstack \`principle-${name}\`]`,
      );
    }
    expect(principle("search-first")).toContain("Origin: the ECC");
  });

  it("resolves every principle that a Playbook cites", () => {
    for (const file of readdirSync(playbookDir)) {
      const text = readFileSync(join(playbookDir, file), "utf8");
      const line = text.match(/^\*\*Principles:\*\* (.+)$/mu)?.[1];
      expect(line).toBeDefined();
      const cited = Array.from(line!.matchAll(/`([a-z-]+)`/gu), (m) => m[1]);
      for (const name of cited.filter((n) => n !== "diagnose")) {
        expect(PRINCIPLES).toContain(name);
      }
    }
  });

  it("links principles only to principles that exist", () => {
    for (const name of PRINCIPLES) {
      for (const [, target] of principle(name).matchAll(
        /\]\(([a-z-]+)\.md\)/gu,
      )) {
        expect(PRINCIPLES).toContain(target);
      }
    }
  });

  it("moves search-first into a principle plus investigation dispatch", () => {
    expect(existsSync(join(root, "skills", "search-first"))).toBe(false);
    const rule = principle("search-first");
    const checks = [
      "1. **Repository** —",
      "2. **Stdlib** —",
      "3. **Native platform** —",
      "4. **Already-installed dependency** —",
    ].map((check) => rule.indexOf(check));
    expect(checks.every((position) => position >= 0)).toBe(true);
    expect(checks).toEqual(checks.toSorted((a, b) => a - b));
    for (const requirement of [
      "safety",
      "correctness",
      "accessibility",
      "edge cases",
    ]) {
      expect(rule).toContain(requirement);
    }

    const investigation = readFileSync(
      join(playbookDir, "investigation.md"),
      "utf8",
    );
    expect(investigation).toContain("The main session owns research dispatch");
    expect(investigation).toContain('agent: "researcher"');
    expect(investigation).toContain("fresh task-only child");
    expect(investigation).toContain(
      "search the repository directly in the main session without launching a researcher",
    );
    expect(investigation).toContain(
      "Local checks already completed: [FINDINGS]",
    );
    expect(investigation).not.toContain("subagent_type");
  });
});
