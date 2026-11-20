import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("take-over skill contract (wiring, not model adherence)", () => {
  const skill = read("skills/take-over/SKILL.md");

  it("orders restate, gaps, examples, lock", () => {
    const phases = [
      "## A. Restate",
      "## B. Find the gaps",
      "## C. Walk through examples",
      "## D. Lock",
    ].map((heading) => skill.indexOf(heading));
    for (const [index, position] of phases.entries()) {
      expect(position).toBeGreaterThan(index ? (phases[index - 1] ?? 0) : 0);
    }
  });

  it("stays read-only until the user locks the process", () => {
    expect(skill).toContain(
      "Keep this skill read-only until the user locks the process",
    );
    expect(skill).toContain(
      "Do not go on until the user confirms the restatement.",
    );
    expect(skill).toContain("`Lock process, stop here` and `Keep refining`");
    expect(skill).toContain("act only on the user's pick");
  });

  it("asks one question at a time across the four gap areas", () => {
    expect(skill).toContain("Ask one question per round");
    for (const area of [
      "**Decisions:**",
      "**Information:**",
      "**Checks:**",
      "**Escalation:**",
    ]) {
      expect(skill).toContain(area);
    }
    expect(skill).toContain("Follow the `grilling` skill for `ask`");
    expect(skill).toContain("Find facts in the environment before you ask");
  });

  it("tests the process on 2–3 dry-run examples", () => {
    expect(skill).toContain("Pick 2–3 real cases");
    expect(skill).toContain("do a dry run in the reply, without side effects");
  });

  it("is reached from /take-over", () => {
    const alias = read("prompts/take-over.md");
    expect(alias).toContain("Use the `take-over` skill as canonical");
    expect(alias).toContain(
      "listed in `<available_skills>` directly; do not search for it.",
    );
    expect(alias.split("\n").length).toBeLessThan(16);
  });

  it("credits Lauren Tan without an invented link", () => {
    expect(skill).toContain("Lauren Tan (poteto)");
    expect(skill).toContain("they have no public source we can link");
  });
});
