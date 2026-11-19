import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("prune-tests skill contract (wiring, not model adherence)", () => {
  const skill = read("skills/prune-tests/SKILL.md");

  it("defers the behavior judgment to the Principle", () => {
    expect(skill).toContain(
      "The `test-behavior-not-implementation` Principle owns the judgment",
    );
    expect(
      existsSync(
        join(root, "rules/principles/test-behavior-not-implementation.md"),
      ),
    ).toBe(true);
  });

  it("classifies in a fixed order, first match decides", () => {
    const steps = [
      "1. **Duplicate.**",
      "2. **The past.**",
      "3. **Nothing.**",
      "4. **The implementation.**",
      "5. **Behavior.**",
    ].map((step) => skill.indexOf(step));
    expect(steps.every((position) => position >= 0)).toBe(true);
    expect(steps).toEqual(steps.toSorted((a, b) => a - b));
  });

  it("proves rewrites by breaking behavior and guards production deletes", () => {
    expect(skill).toContain("break the behavior it guards");
    expect(skill).toContain("restore before you go on");
    expect(skill).toContain("see the kept test fail, then restore the code");
    expect(skill).toContain("non-use proof from the `simplify` skill");
    expect(skill).toContain("Move it to Trash with `trash`");
  });

  it("is reached from /prune-tests", () => {
    const alias = read("prompts/prune-tests.md");
    expect(alias).toContain("Use the `prune-tests` skill as canonical");
    expect(alias).toContain(
      "listed in `<available_skills>` directly; do not search for it.",
    );
  });

  it("credits caldoai with the retained MIT notice", () => {
    expect(skill).toContain(
      "Maze's MIT-licensed [caldoai `prune-tests` skill]",
    );
    expect(read("skills/prune-tests/LICENSE.upstream")).toContain(
      "Copyright (c) 2026 Maze",
    );
  });
});
