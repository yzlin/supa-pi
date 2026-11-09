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
  "correct",
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

  it("keeps investigation and diagnose triggers disjoint", () => {
    const hub = read("skills/supapi-mode/SKILL.md");
    const trigger = (name: string) =>
      hub.split("\n").find((line) => line.startsWith(`| \`${name}\` |`)) ?? "";
    expect(trigger("investigation")).toContain("no failing behavior");
    expect(trigger("investigation")).toContain(
      "A question about why something fails is not an investigation.",
    );
    expect(trigger("diagnose")).toContain("Explicit only:");
    expect(trigger("diagnose")).toContain("Other failures route to `bug-fix`.");
    expect(read("skills/supapi-mode/playbooks/bug-fix.md")).toContain(
      "If the user asked only why it fails, and did not ask for a fix, stop here",
    );
    // Regression: bug-fix used to "switch to the diagnose Playbook", which
    // contradicts Diagnose's explicit-only activation.
    const bugFix = read("skills/supapi-mode/playbooks/bug-fix.md");
    expect(bugFix).toContain(
      "offer `/diagnose`; do not enter it without the user's request",
    );
    expect(bugFix).not.toContain("switch to the `diagnose` Playbook");
  });

  it("sizes how-it-works questions and reuses that step from other Playbooks", () => {
    const playbook = (name: string) =>
      readFileSync(
        join(root, "skills", "supapi-mode", "playbooks", `${name}.md`),
        "utf8",
      );
    const investigation = playbook("investigation");
    expect(investigation).toContain("size it first");
    expect(investigation).toContain("gets 2–4 `explorer` children in parallel");
    expect(investigation).toContain(
      "open every cited location before you report it",
    );
    expect(investigation).toContain("When in doubt, stay in the main session.");
    expect(investigation).toContain(
      "state the size and the reason in one line before you read",
    );
    for (const name of ["bug-fix", "feature", "refactoring"]) {
      expect(playbook(name)).toContain(
        "sized as in the `investigation` Playbook step 2",
      );
    }
  });

  it("runs an independent review before the PR step in build Playbooks", () => {
    const hub = read("skills/supapi-mode/SKILL.md");
    const simplify = hub.indexOf(
      "run the `simplify` skill on the changed files",
    );
    const review = hub.indexOf("the `review-orchestration` skill on the diff");
    expect(hub).toContain("**Review gate:**");
    expect(simplify).toBeGreaterThan(0);
    expect(simplify).toBeLessThan(review);
    expect(hub).toContain(
      "crosses a module boundary, changes a public API, or the user is away",
    );
    expect(hub).toContain("say why you skipped it");
    expect(hub).toContain(
      "through steps 1–7 of the `fix-review-findings` Playbook",
    );
    for (const name of ["bug-fix", "feature", "refactoring"]) {
      const text = read(`skills/supapi-mode/playbooks/${name}.md`);
      const gate = text.indexOf(
        "Run the review gate from the `supapi-mode` Shared rules",
      );
      expect(gate).toBeGreaterThan(0);
      expect(gate).toBeLessThan(
        text.indexOf("run the `opening-a-pr` Playbook"),
      );
      // One owner: the gate text lives only in the hub.
      expect(text).not.toContain(
        "the `review-orchestration` skill on the diff",
      );
    }
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

  it("isolates parallel writers in worktrees instead of a shared checkout", () => {
    const principle = read(
      "rules/principles/separate-before-serializing-shared-state.md",
    );
    expect(principle).toContain(".pi/worktrees/<slug>");
    expect(principle).toContain("git worktree prune");
    expect(principle).toContain(
      "Do not use `git worktree remove`; it deletes permanently.",
    );
    for (const file of [
      "skills/figure-it-out/SKILL.md",
      "skills/supapi-mode/playbooks/feature.md",
    ]) {
      expect(read(file)).toContain(
        "`separate-before-serializing-shared-state`",
      );
    }
  });

  it("scopes unattended pushes to the run's own branch", () => {
    const execute = read("skills/supapi-mode/playbooks/execute.md");
    expect(execute).toContain("`agent/<slug>`");
    expect(execute).toContain("`--force-with-lease=agent/<slug>:<sha>`");
    expect(execute).toContain("a push you did not make");
    expect(read("skills/figure-it-out/SKILL.md")).toContain(
      "the execute Playbook's push scope",
    );
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
