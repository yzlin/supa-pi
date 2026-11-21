import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const table = read("docs/context/enforced-rules.md");
const rows = table
  .split("\n")
  .filter((line) => line.startsWith("| ") && !line.startsWith("| Rule |"))
  .filter((line) => !line.startsWith("| --- |"));

describe("enforced-rules table contract", () => {
  it("names only enforcing files that exist", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const enforcedBy = row.split(" | ")[1] ?? "";
      for (const [, path] of enforcedBy.matchAll(/`([\w./-]+\.(?:ts|md))`/gu)) {
        expect({ row, path, exists: existsSync(join(root, path)) }).toEqual({
          row,
          path,
          exists: true,
        });
      }
    }
  });

  it("gives every row a level that is a rung of the correct Playbook ladders", () => {
    const playbook = read("skills/supapi-mode/playbooks/correct.md");
    const ladder = (heading: string) => {
      const start = playbook.indexOf(`**${heading}:**`);
      expect(start).toBeGreaterThanOrEqual(0);
      const block = playbook.slice(start).split("\n\n")[0] ?? "";
      return [...block.matchAll(/^\s+\d\. \*\*([^:*]+?)[:,]?\*\*/gmu)].map(
        ([, rung]) => rung?.toLowerCase(),
      );
    };
    const rungs = {
      code: ladder("Code mistakes"),
      action: ladder("Action mistakes"),
    };
    expect(rungs).toEqual({
      code: [
        "architecture",
        "types",
        "a check whose failure names the fix",
        "a behavior test",
        "prose",
      ],
      action: [
        "remove the affordance",
        "typed-tool refusal",
        "shell-command refusal",
        "eval or session detector",
        "prose",
      ],
    });
    const allowed = new Set([
      "code: architecture",
      "code: types",
      "code: check",
      "code: behavior test",
      "code: prose",
      ...rungs.action.map((rung) => `action: ${rung}`),
    ]);
    for (const row of rows) {
      const cells = row.split(" | ");
      expect(cells).toHaveLength(3);
      const level = cells[2]?.replace(/ \|$/u, "").trim();
      expect({ row, level, allowed: allowed.has(level ?? "") }).toEqual({
        row,
        level,
        allowed: true,
      });
    }
  });

  it("is maintained by the correct Playbook and reached from /correct", () => {
    const playbook = read("skills/supapi-mode/playbooks/correct.md");
    expect(playbook).toContain("Update `docs/context/enforced-rules.md`");
    expect(playbook).toContain(
      "Prove each new check fails on a real past mistake",
    );
    expect(playbook).toContain("A class counts once it has happened twice");
    expect(playbook).toContain(
      "Do not weaken or delete a check to make a change pass.",
    );
    const alias = read("prompts/correct.md");
    expect(alias).toContain("Use the `correct` Playbook as canonical");
    expect(alias).toContain(
      "listed in `<available_skills>` directly; do not search for it.",
    );
    expect(playbook).toContain(
      "Query recent Pi sessions for this cwd with `session_query`",
    );
    expect(playbook).toContain(
      "a reason, an expiry date, and the user's approval",
    );
    expect(playbook).toContain(
      "A test that only checks that a sentence is present counts as prose",
    );
    expect(read("CONTEXT-MAP.md")).toContain("docs/context/enforced-rules.md");
    expect(read("AGENTS.global.md")).toContain(
      "Corrected a mistake: check `docs/context/enforced-rules.md`",
    );
  });
});
