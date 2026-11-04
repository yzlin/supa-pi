import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const root = join(import.meta.dir, "..", "..");
const hubDir = join(root, "skills", "supapi-mode");
const playbookDir = join(hubDir, "playbooks");
const playbookRow = /^\| `([a-z-]+)` \|/gmu;
const PLAYBOOKS = [
  "bug-fix",
  "diagnose",
  "execute",
  "feature",
  "fix-review-findings",
  "investigation",
  "opening-a-pr",
  "prototype",
  "refactoring",
];

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("supapi-mode hub contract (not model adherence)", () => {
  it("loads as one skill; playbooks are not separate skills", () => {
    const loaded = loadSkillsFromDir({
      dir: join(root, "skills"),
      source: "test",
    });
    const names = loaded.skills.map((skill) => skill.name);
    expect(names).toContain("supapi-mode");
    expect(names).toContain("figure-it-out");
    expect(
      loaded.skills.filter((skill) => skill.filePath.startsWith(playbookDir)),
    ).toEqual([]);
  });

  it("routes to exactly the playbook files that exist", () => {
    const hub = read("skills/supapi-mode/SKILL.md");
    const routed = Array.from(hub.matchAll(playbookRow), ([, name]) => name);
    const files = readdirSync(playbookDir)
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.replace(/\.md$/u, ""));
    expect(routed.toSorted()).toEqual(PLAYBOOKS);
    expect(files.toSorted()).toEqual(PLAYBOOKS);
  });

  it("falls back to figure-it-out and keeps trivial work direct", () => {
    const hub = read("skills/supapi-mode/SKILL.md");
    expect(hub).toContain("load the `figure-it-out` skill instead");
    expect(hub).toContain("If the task turns out to be trivial");
    expect(existsSync(join(root, "skills", "figure-it-out", "SKILL.md"))).toBe(
      true,
    );
  });

  it("delegates diagnose and refactoring to their canonical skills", () => {
    expect(read("skills/supapi-mode/playbooks/diagnose.md")).toContain(
      "Load the `diagnose` skill and follow it as canonical.",
    );
    expect(read("skills/supapi-mode/playbooks/refactoring.md")).toContain(
      "load the `simplify` skill and follow it as canonical",
    );
  });

  it("is reached from the always-on core prompt pointer", () => {
    const routing = read("extensions/core-prompt/prompt.md")
      .split("<routing>")[1]
      ?.split("</routing>")[0];
    expect(routing).toContain(
      "load the `supapi-mode` skill and follow the Playbook it matches",
    );
    expect(routing).toContain("Trivial edits and lookups stay direct.");
  });

  it("credits pstack", () => {
    expect(read("skills/supapi-mode/SKILL.md")).toContain(
      "Lauren Tan's MIT-licensed",
    );
    expect(read("skills/figure-it-out/SKILL.md")).toContain(
      "Lauren Tan's MIT-licensed",
    );
  });
});
