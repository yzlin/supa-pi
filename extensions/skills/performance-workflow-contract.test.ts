import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = process.cwd();
const rulePath = join(repositoryRoot, "rules", "common", "performance.md");
const skillPath = join(
  repositoryRoot,
  "skills",
  "performance-optimization",
  "SKILL.md"
);

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

describe("performance workflow ownership contract", () => {
  it("routes actual performance work through a real rule-relative link to the canonical skill", () => {
    const rule = readFile(rulePath);
    const skillLink = "../../skills/performance-optimization/SKILL.md";

    expect(rule).toContain("For actual performance work");
    expect(rule).toContain("MUST read and follow");
    expect(rule).toContain(`[Performance Optimization](${skillLink})`);

    const resolvedSkillPath = resolve(dirname(rulePath), skillLink);
    expect(resolvedSkillPath).toBe(skillPath);
    expect(existsSync(resolvedSkillPath)).toBe(true);
    expect(readFile(resolvedSkillPath)).toContain("# Performance Optimization");
  });

  it("keeps the five-step method once in the skill and not in the common rule", () => {
    const rule = readFile(rulePath);
    const skill = readFile(skillPath);

    for (const step of [
      "Measure",
      "Identify",
      "Fix",
      "Verify",
      "Guard",
    ] as const) {
      const numberedStep = new RegExp(`^\\d+\\. \\*\\*${step}\\*\\*:`, "gm");
      expect(skill.match(numberedStep)?.length).toBe(1);
      expect(rule.match(numberedStep)).toBeNull();
    }

    expect(occurrences(skill, "## Workflow")).toBe(1);
    expect(rule).not.toContain("Use this workflow for performance work:");
  });

  it("limits investigation to actual performance work rather than routine bounded work", () => {
    const rule = readFile(rulePath);

    expect(rule).toContain("performance requirements");
    expect(rule).toContain("reported or suspected regression");
    expect(rule).toContain("measured bottleneck");
    expect(rule).toContain(
      "Routine work that is already bounded and has no concrete performance signal does not require a performance investigation."
    );
    expect(rule).not.toContain("all tasks must perform performance work");
    expect(rule).not.toContain("every task must perform performance work");
  });

  it("preserves mandatory bounded checks, anti-speculation policy, and blocked-measurement review", () => {
    const rule = readFile(rulePath);

    expect(rule).toContain(
      "Measure before optimizing. Do not add complexity for speculative performance gains."
    );
    expect(rule).toContain("## Mandatory Performance Checks");
    expect(rule).toContain(
      "For non-trivial features or suspected regressions, check for:"
    );
    expect(rule).toContain(
      "unbounded fetches, list endpoints, result sets, queues, or file reads"
    );
    expect(rule).toContain("## Review Standard");
    expect(rule).toContain(
      "If measurement is blocked, state what is missing and why the risk still matters."
    );
  });
});
