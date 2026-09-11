import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readRepoFile(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

describe("agent prompt contracts", () => {
  it("keeps complexity findings concrete in the existing reviewer schema", () => {
    const reviewer = readRepoFile("agents", "code-reviewer.md");

    expect(reviewer).toContain(
      "For a complexity finding, use the existing `file`, `line`, `why`, and `change` fields"
    );
    expect(reviewer).toContain("concrete unnecessary mechanism to cut");
    expect(reviewer).toContain("replacement or explicitly `none`");
    expect(reviewer).toContain(
      "evidence/verification that required contracts remain supported"
    );
    expect(reviewer).toContain(
      "Do not add a replacement schema, create a complexity-only mode, score complexity by line count, or hide safety findings."
    );
    expect(reviewer).toContain("findings");
    expect(reviewer).toContain("humanReviewerCallouts");
  });

  it("keeps existing-capability replacement within the simplifier scope", () => {
    const simplifier = readRepoFile("agents", "code-simplifier.md");

    expect(simplifier).toContain(
      "Within the assigned scope, consider replacing an in-scope custom mechanism"
    );
    expect(simplifier).toContain(
      "repository, standard-library, native-platform, or already-installed dependency capability"
    );
    expect(simplifier).toContain(
      "Do not widen editable files for it; if another file or new package research is needed, stop and report it."
    );
  });
});
