import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("ketchup skill contract (wiring, not model adherence)", () => {
  const skill = read("skills/ketchup/SKILL.md");

  it("is read-only and checks live state before reporting", () => {
    expect(skill).toContain("Keep this turn read-only");
    expect(skill).toContain(
      "A step you reported as done but cannot see is not done.",
    );
    expect(skill).toContain(
      "Check each number you will show against its source",
    );
  });

  it("defines action items as calls only the user can make", () => {
    expect(skill).toContain(
      "An **action item** is a call only the user can make",
    );
    expect(skill).toContain(
      "Work you can still do yourself is not an action item.",
    );
    expect(skill).toContain("Never invent a call to fill the reply.");
    expect(skill).toContain("Never cut or merge items to stay short");
  });

  it("opens with what waits on the user and keeps visuals in showing-me", () => {
    expect(skill).toContain(
      "**Open** with one sentence that names what waits on the user",
    );
    expect(skill).toContain("Apply the `showing-me` skill");
    expect(skill).toContain("Never draw a status list or the action items");
  });

  it("is reached from /ketchup", () => {
    const alias = read("prompts/ketchup.md");
    expect(alias).toContain("Use the `ketchup` skill as canonical");
    expect(alias).toContain(
      "listed in `<available_skills>` directly; do not search for it.",
    );
    expect(alias.split("\n").length).toBeLessThan(16);
  });

  it("credits pstack", () => {
    expect(skill).toContain(
      "Lauren Tan's MIT-licensed [pstack `ketchup` skill]",
    );
  });
});
