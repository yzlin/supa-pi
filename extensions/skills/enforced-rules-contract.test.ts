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

  it("gives every row a level, with prose-only rows marked as such", () => {
    for (const row of rows) {
      const cells = row.split(" | ");
      expect(cells).toHaveLength(3);
      expect(cells[2]?.replace(/ \|$/u, "").trim()).not.toBe("");
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
    expect(read("CONTEXT-MAP.md")).toContain("docs/context/enforced-rules.md");
    expect(read("skills/retro/SKILL.md")).toContain(
      "name `/correct` as its separate work",
    );
    expect(read("skills/retro/SKILL.md")).toContain("Retro stays report-only.");
  });
});
