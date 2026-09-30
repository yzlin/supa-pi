import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = process.cwd();
const browserSkillPath = join(
  repositoryRoot,
  "skills",
  "web-browser",
  "SKILL.md",
);
const e2eSkillPath = join(repositoryRoot, "skills", "e2e-testing", "SKILL.md");
const developmentWorkflowPath = join(
  repositoryRoot,
  "rules",
  "common",
  "development-workflow.md",
);

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

describe("web-browser routing instruction assertions (not proof of model compliance)", () => {
  it("publishes discovery for interactive web E2E and ordinary web issue diagnosis", () => {
    const skill = readFile(browserSkillPath);
    const frontmatterEnd = skill.indexOf("\n---", 4);

    expect(frontmatterEnd).toBeGreaterThan(0);
    const description = skill.slice(0, frontmatterEnd);

    expect(description).toContain("interactive web E2E");
    expect(description).toContain("ordinary web issue diagnosis");
    expect(description).toContain("outside `/diagnose`");
  });

  it("makes the skill scripts canonical and keeps headless as the default", () => {
    const skill = readFile(browserSkillPath);

    for (const instruction of [
      "this skill is the canonical browser-interaction route",
      "MUST use the scripts in this skill (`./scripts/`)",
      "agent-driven web interaction",
      "headless by default",
      "./scripts/start.js --headless",
    ]) {
      expect(skill).toContain(instruction);
    }

    for (const script of ["start.js", "nav.js", "eval.js", "screenshot.js"]) {
      expect(
        existsSync(join(dirname(browserSkillPath), "scripts", script)),
      ).toBe(true);
    }
  });

  it("asserts explicit pi-computer-use authorization and blocker reporting", () => {
    const skill = readFile(browserSkillPath);

    for (const instruction of [
      "`pi-computer-use`, including its browser-capable tools, requires an explicit user request",
      "A launch or capability blocker alone is not authorization",
      "report the blocker and ask the user to explicitly request `pi-computer-use`",
    ]) {
      expect(skill).toContain(instruction);
    }

    expect(skill.indexOf("canonical browser-interaction route")).toBeLessThan(
      skill.indexOf("pi-computer-use"),
    );
  });

  it("preserves project E2E runner authoring and execution and native/desktop use", () => {
    const skill = readFile(browserSkillPath);

    for (const instruction of [
      "Preserve authoring and execution of existing project E2E runners",
      "Playwright, Cypress, or another repository runner",
      "do not replace the runner",
      "Native/desktop use is unaffected",
    ]) {
      expect(skill).toContain(instruction);
    }
  });

  it("links callers to one resolvable browser contract without duplicating its protocol", () => {
    const callers = [
      {
        path: e2eSkillPath,
        link: "../web-browser/SKILL.md",
        marker: "canonical [web-browser skill]",
      },
      {
        path: developmentWorkflowPath,
        link: "../../skills/web-browser/SKILL.md",
        marker: "canonical [web-browser skill]",
      },
    ] as const;

    for (const caller of callers) {
      const content = readFile(caller.path);
      const resolvedSkillPath = resolve(dirname(caller.path), caller.link);

      expect(content).toContain(caller.marker);
      expect(content).toContain(`(${caller.link})`);
      expect(occurrences(content, caller.link)).toBe(1);
      expect(resolvedSkillPath).toBe(browserSkillPath);
      expect(existsSync(resolvedSkillPath)).toBe(true);
      expect(content).not.toContain("./scripts/");
      expect(content).not.toContain("pi-computer-use");
    }
  });
});
