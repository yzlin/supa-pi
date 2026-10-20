import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";

const root = join(import.meta.dir, "..", "..");
const skillDir = join(root, "skills", "to-spec");
const briefHeading = /^## (.+)$/gmu;

function readSkill(): string {
  return readFileSync(join(skillDir, "SKILL.md"), "utf8");
}

function expectInstructions(requirements: string[]): void {
  const skill = readSkill();
  for (const requirement of requirements) {
    expect(skill).toContain(requirement);
  }
}

describe("to-spec resource and instruction contract (not model adherence)", () => {
  it("loads an explicit wrapper that remains in the command packet's skill catalog", () => {
    const loaded = loadSkillsFromDir({ dir: skillDir, source: "test" });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.skills).toHaveLength(1);
    expect(loaded.skills[0]).toMatchObject({
      name: "to-spec",
      filePath: join(skillDir, "SKILL.md"),
      disableModelInvocation: false,
    });
    expect(loaded.skills[0]?.description).toContain(
      "/execute draft-then-execute packet",
    );
    expect(formatSkillsForPrompt(loaded.skills)).toContain("to-spec");
    expect(readSkill()).not.toContain("disable-model-invocation");
    expectInstructions([
      "Explicit /to-spec wrapper",
      "Use when the user invokes /to-spec or when an /execute draft-then-execute packet requests it",
      "persists the current conversation's locked plan as a Spec for /execute.",
      "execute Extension's `/to-spec` packet",
      "optional slug",
      "unaccepted Spec already exists",
    ]);
  });

  it("synthesizes without interview and asks only for an unknown verification seam", () => {
    expectInstructions([
      "Synthesize from the current conversation and codebase understanding",
      "Do not interview",
      "`CONTEXT.md` glossary vocabulary",
      "respect ADRs in the touched area",
      "Ask exactly one testing-seam question with the `ask` tool only when Verification would otherwise be a guess",
      "prefer existing, highest seams",
      "Do not invent unresolved decisions",
    ]);
  });

  it("defines a plain Markdown brief with ordered detection headings and optional seams", () => {
    const template = readSkill().split("```markdown\n")[1]?.split("```")[0];
    expect(template).toBeDefined();
    expect(template?.startsWith("# Execution Brief\n")).toBe(true);
    expect(
      Array.from(
        (template ?? "").matchAll(briefHeading),
        ([, heading]) => heading,
      ),
    ).toEqual([
      "Execution Scope",
      "User Stories",
      "Plan",
      "Done Criteria",
      "Verification",
      "Testing Seams",
      "Out of Scope",
    ]);
    expectInstructions([
      "plain Markdown, no frontmatter",
      "status lives in the Spec log",
      "`Testing Seams` is optional",
      "`Execution Scope`, `Plan`, `Done Criteria`, `Verification`, and `Out of Scope` are required for `/execute` brief detection",
      "literal workspace-relative paths where known",
      "`/execute` write scopes",
    ]);
  });

  it("requires minimal user stories and bidirectional done-criterion coverage before writing", () => {
    expectInstructions([
      "user- or caller-visible behavior changes",
      "US-1",
      "As a <actor>, I want <capability>, so that <benefit>",
      "one story per distinct actor+outcome, no padding",
      "exactly one line: `N/A — internal: <reason>`",
      "each story maps to at least one Done Criterion",
      "each Done Criterion ends with `(US-n)` citations or `(technical)`",
      "Fix gaps before writing",
    ]);
  });

  it("validates slug and refuses logged collisions while confirming unaccepted replacements", () => {
    expectInstructions([
      "given slug or derive a short kebab-case slug from the goal",
      "^[a-z0-9][a-z0-9-]*$",
      "at most 48 characters",
      "If `.pi/specs/<slug>.log.jsonl` exists, refuse and suggest a new slug",
      "If only `.pi/specs/<slug>.md` exists, ask with `ask` before overwriting",
      "Without confirmation, do not overwrite",
      "Recheck collisions before writing",
    ]);
  });

  it("limits writes to the Spec and hands off to explicit execute and status commands", () => {
    expectInstructions([
      "Write only `.pi/specs/<slug>.md`",
      "create the `.pi/specs/` directory",
      "local and git-ignored",
      "Never write or edit the Spec log or Snapshot refs",
      "Never edit a Spec after it is accepted",
      "changes go through `/execute`'s explicit revision",
      "Print the path",
      "`/execute @.pi/specs/<slug>.md`",
      "a fresh session is fine",
      "`/to-spec status <slug>` shows progress",
      "before compaction when context is near its limit",
    ]);
  });

  it("starts execution only from the /execute draft-then-execute packet", () => {
    expectInstructions([
      "Suggest the commands; do not start execution automatically",
      "Exception: when invoked as the first step of an `/execute` draft-then-execute packet",
      "continue directly into the `execute` skill on that Spec, passing `specPath` on `accept`",
      "Standalone `/to-spec` never starts execution",
    ]);
  });

  it("credits the MIT-licensed upstream ideas and states rejected parts", () => {
    expectInstructions([
      "Matt Pocock",
      "MIT-licensed",
      "https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md",
      "no-interview synthesis, testing seams, glossary/ADR respect, and out of scope",
      "Rejected parts: issue-tracker publishing and triage labels, extensive story lists, and the no-file-path rule",
    ]);
  });
});
