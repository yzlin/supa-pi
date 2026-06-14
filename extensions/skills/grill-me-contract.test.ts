import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("grill-me skill contract", () => {
  it("keeps the final gate stop-only and never implementation-oriented", () => {
    const skill = readFileSync(
      join(process.cwd(), "skills", "grill-me", "SKILL.md"),
      "utf8"
    );

    expect(skill).toContain("`Lock plan, stop here`");
    expect(skill).toContain("`Keep grilling`");
    expect(skill).toContain("injected custom row for `Type something.`");
    expect(skill).toContain(
      "must not ask whether to proceed to implementation"
    );
    expect(skill).toContain(
      "must not include any implement/proceed/start-coding option"
    );
    expect(skill).not.toContain("Yes, implement this contract");
    expect(skill).not.toContain("implement this contract");
  });
});
