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
  "triage",
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

  it("routes through triage to exactly the playbook files that exist", () => {
    const hub = read("skills/supapi-mode/SKILL.md");
    expect(hub).toContain(
      "Read `playbooks/triage.md` next to this file and follow it.",
    );
    expect(Array.from(hub.matchAll(playbookRow))).toEqual([]);
    const triage = read("skills/supapi-mode/playbooks/triage.md");
    const routed = Array.from(
      triage.matchAll(/^ {3}\| `([a-z-]+)` \|/gmu),
      ([, name]) => name,
    );
    const files = readdirSync(playbookDir)
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.replace(/\.md$/u, ""));
    expect(routed.toSorted()).toEqual(
      PLAYBOOKS.filter((name) => name !== "triage"),
    );
    expect(files.toSorted()).toEqual(PLAYBOOKS);
  });

  it("triage orders bypass, kind, learn, size, tier call, dispatch, escalate", () => {
    const triage = read("skills/supapi-mode/playbooks/triage.md");
    const steps = [
      "2. Explicit commands skip triage",
      "3. Pick the first kind below",
      "4. Learn before you size",
      "5. Size the job.",
      "6. Before the first edit, call the `tier` tool with the tier and the hard trigger or soft signals that set it.",
      "Call it right after sizing, before any tool call that writes, including a Spec",
      "a tier declared after work started does not count",
      "Use the tool, not a text line: some models return prose written between tool calls as a summarized thinking block",
      "7. Dispatch:",
      "8. Escalate when a T1 run hits a hard trigger.",
      "call the `tier` tool again with tier 2 and the trigger",
      "**Reply:** for a build kind, start with a `Tier: T<n> — <reason>` line for each `tier` call you made",
    ].map((step) => triage.indexOf(step));
    for (const [index, position] of steps.entries()) {
      expect(position).toBeGreaterThan(index ? (steps[index - 1] ?? -1) : 0);
    }
    for (const rule of [
      "except `execute`, which is always Spec-backed: call the `tier` tool with tier 2 and reason `execute` first",
      "`/execute`, `/pr`, `/diagnose`, `/correct`, and `/review-fix` open their Playbook directly",
      "**T2 or higher:** a one-way door",
      "a change to a public API, file format, or output that code outside this repository reads",
      "the user asks for a Spec, proof, or `/execute`",
      "two or more subsystems that `CONTEXT-MAP.md` lists separately",
      "**T3:** the work runs unattended or across sessions",
      "three or more user-visible outcomes, four or more units, an area with no tests or docs, or a fix that already failed once",
      "**T0** only for a typo, one local line, or a lookup",
      "**T0:** work directly.",
      "**T1:** follow the kind Playbook. Its build steps follow the Unit loop",
      "**T2:** run the kind Playbook's design steps (feature 1–3, bug-fix 1–2, refactoring 1–2), then follow the `execute` Playbook from step 1 with the plan as `/execute <plan text>`",
      "a bug-fix repro becomes a Done Criterion and a `(baseline)` lane; a refactoring pin becomes a Done Criterion",
      "**T3:** load the `figure-it-out` skill.",
      "The Spec names the edits made so far in its Execution Scope and Plan",
      "No `(baseline)` lane covers behavior those edits already changed",
      "Never lower a tier on your own",
    ]) {
      expect(triage).toContain(rule);
    }
    expect(triage).not.toContain("write one line that starts with `Tier:");
    expect(read("skills/supapi-mode/SKILL.md")).toContain(
      "Right after sizing, call the `tier` tool, before any tool call that writes.",
    );
  });

  it("falls back to figure-it-out and keeps trivial work direct", () => {
    const triage = read("skills/supapi-mode/playbooks/triage.md");
    expect(triage).toContain("**T3:** load the `figure-it-out` skill.");
    expect(triage).toContain("**T0:** work directly.");
    const figure = read("skills/figure-it-out/SKILL.md");
    expect(figure).not.toContain("supapi-mode fallback");
    const [, frontmatter = "", body = ""] = figure.split("---");
    const opening =
      body
        .split("\n\n")
        .map((part) => part.trim())
        .find((part) => part && !part.startsWith("#")) ?? "";
    for (const part of [frontmatter, opening]) {
      expect(part).toContain("tier T3");
      expect(part).toContain("unattended or across sessions");
      expect(part).toContain("no Playbook fits");
    }
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
    const triage = read("skills/supapi-mode/playbooks/triage.md");
    const trigger = (name: string) =>
      triage
        .split("\n")
        .find((line) => line.trimStart().startsWith(`| \`${name}\` |`)) ?? "";
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
    expect(hub).toContain("for every non-trivial diff");
    expect(hub).toContain("say why you skipped it");
    expect(hub).toContain(
      "through steps 1–7 of the `fix-review-findings` Playbook in gate mode",
    );
    expect(hub).toContain(
      "fix what you are sure about and list the rest for the user to review",
    );
    const fix = read("skills/supapi-mode/playbooks/fix-review-findings.md");
    expect(fix).toContain("**Gate mode**");
    expect(fix).toContain("`For your review`");
    expect(fix).toContain("Do not call `ask` in gate mode");
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
    const execute = read("skills/supapi-mode/playbooks/execute.md");
    const finish = execute.slice(execute.indexOf("## 7. Finish"));
    const gate = finish.indexOf(
      "Run the review gate from the `supapi-mode` Shared rules",
    );
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(finish.indexOf("`bun run check`"));
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
      "skills/supapi-mode/SKILL.md",
    ]) {
      expect(read(file)).toContain(
        "`separate-before-serializing-shared-state`",
      );
    }
  });

  it("keeps one Unit loop in the hub", () => {
    const hub = read("skills/supapi-mode/SKILL.md");
    const loop = hub.slice(
      hub.indexOf("- **Unit loop:**"),
      hub.indexOf("- **Review gate:**"),
    );
    expect(loop.length).toBeGreaterThan(0);
    for (const phrase of [
      "riskiest unknown first",
      "own worktree",
      "a child's report is a claim",
      "two repair attempts",
      "blast-radius",
    ]) {
      expect(loop).toContain(phrase);
    }
    for (const name of ["feature", "refactoring", "execute"]) {
      expect(read(`skills/supapi-mode/playbooks/${name}.md`)).toContain(
        "Unit loop",
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
