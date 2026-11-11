import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { runSpecLog, SpecLogResult, specLogCallLabel } from "./index";
import { hashSpec, lintSpec, readSpecLog, renderSpecStatus } from "./spec";

const SPEC = `# Execution Brief

## Execution Scope
Add a greeting.

## User Stories
- US-1: As a user, I want a greeting, so that I feel welcome.

## Plan
1. Edit src/greet.ts.

## Done Criteria
- DC-1: greet() returns "hi" (US-1)
  Evidence: bun test tests/greet.test.ts passes
- DC-2: repository check passes (technical)
  Evidence: bun run check exits 0

## Live Lanes
- LANE-1: run the greeting CLI (DC-1) (baseline)
  Drive: bun src/cli.ts
  Artifact: $TMPDIR/pi-verify/greet/cli.txt
  Pass when: output is "hi"
  Baseline: the same command at the base prints nothing
- LANE-2: import greet in a REPL (DC-1)
  Drive: bun -e 'import {greet} from "./src/greet"; console.log(greet())'
  Artifact: $TMPDIR/pi-verify/greet/repl.txt
  Pass when: output is "hi"
- LANE-3: run the full check (DC-2)
  Drive: bun run check
  Artifact: $TMPDIR/pi-verify/greet/check.txt
  Pass when: exit 0

## Verification
Run the commands above.

## Out of Scope
Localization.
`;
const SPEC_PATH = ".pi/specs/greet.md";
const LOG_PATH = ".pi/specs/greet.log.jsonl";
const directories: string[] = [];

function workspace(git = false): string {
  const cwd = mkdtempSync(join(tmpdir(), "spec-log-"));
  directories.push(cwd);
  mkdirSync(join(cwd, ".pi", "specs"), { recursive: true });
  writeFileSync(join(cwd, SPEC_PATH), SPEC);
  if (git) {
    execFileSync("git", ["init", "-q", cwd]);
  }
  return cwd;
}

function run(cwd: string, params: Record<string, unknown>) {
  return runSpecLog(cwd, { specPath: SPEC_PATH, ...params } as never);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("lintSpec", () => {
  it("accepts a well-formed Spec", () => {
    expect(lintSpec(SPEC)).toEqual([]);
  });

  it("reports missing evidence, unlabeled rows, coverage gaps, and order", () => {
    const broken = SPEC.replace(
      "  Evidence: bun test tests/greet.test.ts passes\n",
      "",
    )
      .replace("- DC-2: repository check passes (technical)", "- check passes")
      .replace("- US-1: As a user", "- US-1: As a user\n- US-2: As an admin");
    const errors = lintSpec(broken);
    expect(errors).toContain(
      "DC-1 names no evidence; add an indented `Evidence: <command or check>` line.",
    );
    expect(errors.some((error) => error.includes("lacks a `- DC-n: `"))).toBe(
      true,
    );
    expect(errors).toContain("US-2 is not covered by any Done Criterion.");
    expect(
      lintSpec(SPEC.replace("## Plan", "## Planx")).some((error) =>
        error.startsWith("Missing section: ## Plan"),
      ),
    ).toBe(true);
  });

  it("accepts the internal-only User Stories line", () => {
    const internal = SPEC.replace(
      "- US-1: As a user, I want a greeting, so that I feel welcome.",
      "N/A — internal: refactor only",
    ).replace("(US-1)", "(technical)");
    expect(lintSpec(internal)).toEqual([]);
  });
});

describe("lintSpec Live Lanes", () => {
  const LANES_START = SPEC.indexOf("## Live Lanes");
  const LANES_END = SPEC.indexOf("## Verification");
  const withLanes = (lanes: string) =>
    `${SPEC.slice(0, LANES_START)}## Live Lanes\n${lanes}\n${SPEC.slice(LANES_END)}`;
  const lane = (n: number, tail = "(DC-1)", extra = "") =>
    `- LANE-${n}: scenario ${n} ${tail}\n  Drive: run ${n}\n  Artifact: /tmp/a${n}.txt\n  Pass when: ok${extra}\n`;
  const BASE = `${lane(1, "(DC-1) (baseline)", "\n  Baseline: base prints nothing")}${lane(2)}${lane(3, "(DC-2)")}`;
  const internalSpec = (content: string) =>
    content
      .replace(
        "- US-1: As a user, I want a greeting, so that I feel welcome.",
        "N/A — internal: refactor only",
      )
      .replace("(US-1)", "(technical)");

  it("Live Lanes: accepts three valid lanes with one baseline", () => {
    expect(lintSpec(withLanes(BASE))).toEqual([]);
  });

  it("Live Lanes: requires the section when stories are not internal", () => {
    const without = SPEC.slice(0, LANES_START) + SPEC.slice(LANES_END);
    expect(lintSpec(without)).toContain(
      "Missing section: ## Live Lanes (required unless User Stories is `N/A — internal: <reason>`).",
    );
  });

  it("Live Lanes: an internal-only Spec without the section passes", () => {
    const without = SPEC.slice(0, LANES_START) + SPEC.slice(LANES_END);
    expect(lintSpec(internalSpec(without))).toEqual([]);
  });

  it("Live Lanes: an internal-only Spec with an invalid section fails", () => {
    expect(lintSpec(internalSpec(withLanes(lane(1, "(DC-9)"))))).toContain(
      "LANE-1 cites unknown Done Criterion DC-9.",
    );
  });

  it("Live Lanes: accepts one plain lane with no baseline", () => {
    expect(lintSpec(withLanes(lane(1)))).toEqual([]);
  });

  it("Live Lanes: accepts one baseline lane with a Baseline: line", () => {
    const one = lane(
      1,
      "(DC-1) (baseline)",
      "\n  Baseline: base prints nothing",
    );
    expect(lintSpec(withLanes(one))).toEqual([]);
  });

  it("Live Lanes: rejects an empty section", () => {
    expect(lintSpec(withLanes(""))).toContain(
      "## Live Lanes needs at least 1 lane; found 0.",
    );
  });

  for (const field of ["Drive", "Artifact", "Pass when"]) {
    it(`Live Lanes: rejects a lane missing ${field}:`, () => {
      const broken = BASE.replace(
        new RegExp(`\\n  ${field}: [^\\n]*`, "u"),
        "",
      );
      expect(lintSpec(withLanes(broken))).toContain(
        `LANE-1 has no indented \`${field}:\` line.`,
      );
    });
  }

  it("Live Lanes: rejects (baseline) without a Baseline: line", () => {
    const broken = BASE.replace("\n  Baseline: base prints nothing", "");
    expect(lintSpec(withLanes(broken))).toContain(
      "LANE-1 is a (baseline) lane with no `Baseline:` line.",
    );
  });

  it("Live Lanes: rejects a Baseline: line without the (baseline) tag", () => {
    const broken = `${BASE}${lane(4, "(DC-1)", "\n  Baseline: b")}`;
    expect(lintSpec(withLanes(broken))).toContain(
      "LANE-4 has a `Baseline:` line but no (baseline) tag.",
    );
  });

  it("Live Lanes: rejects a repeated LANE-n label", () => {
    expect(lintSpec(withLanes(`${BASE}${lane(2)}`))).toContain(
      "Repeated Live Lane label: LANE-2",
    );
  });

  it("Live Lanes: rejects a lane with no (DC-n) citation", () => {
    expect(lintSpec(withLanes(`${BASE}${lane(4, "")}`))).toContain(
      "LANE-4 must cite at least one Done Criterion as (DC-n).",
    );
  });

  it("Live Lanes: rejects a lane citing an unknown DC", () => {
    expect(lintSpec(withLanes(`${BASE}${lane(4, "(DC-9)")}`))).toContain(
      "LANE-4 cites unknown Done Criterion DC-9.",
    );
  });

  it("Live Lanes: rejects wrong section order", () => {
    const without = SPEC.slice(0, LANES_START) + SPEC.slice(LANES_END);
    const misplaced = without.replace(
      "## Plan",
      `## Live Lanes\n${BASE}\n## Plan`,
    );
    expect(
      lintSpec(misplaced).some((error) =>
        error.startsWith("Sections must appear in order:"),
      ),
    ).toBe(true);
  });

  it("Live Lanes: rejects an unlabeled lane row", () => {
    expect(lintSpec(withLanes(`${BASE}- a lane\n`))).toContain(
      "Live Lanes row lacks a `- LANE-n: ` label: - a lane",
    );
  });
});

describe("spec_log tool", () => {
  it("check does not write done; verify pass writes done", () => {
    const cwd = workspace(true);
    expect(run(cwd, { action: "accept" }).isError).toBe(false);
    expect(
      run(cwd, { action: "check", id: "DC-1", evidence: "" }).isError,
    ).toBe(true);
    const first = run(cwd, {
      action: "check",
      id: "DC-1",
      evidence: "bun test tests/greet.test.ts: 1 pass",
    });
    expect(first.text).toContain('- [x] DC-1: greet() returns "hi" (US-1)');
    expect(first.text).toContain("- [ ] DC-2");
    run(cwd, {
      action: "check",
      id: "DC-2",
      evidence: "bun run check: exit 0",
    });
    const kinds = () =>
      readSpecLog(join(cwd, LOG_PATH)).map((event) => event.event);
    expect(kinds()).toEqual(["accepted", "checked", "checked"]);
    const passed = run(cwd, {
      action: "verify",
      verdict: "pass",
      findings: 0,
      evidence: "dc-verifier run-1: DC-1 PASS, DC-2 PASS",
    });
    expect(passed.isError).toBe(false);
    expect(kinds()).toEqual([
      "accepted",
      "checked",
      "checked",
      "verified",
      "done",
    ]);
    expect(readSpecLog(join(cwd, LOG_PATH)).at(-2)).toMatchObject({
      event: "verified",
      verdict: "pass",
      head: null,
      snapshot: "refs/pi-specs/greet/3",
    });
    const refs = execFileSync("git", [
      "-C",
      cwd,
      "for-each-ref",
      "refs/pi-specs/",
    ]).toString();
    expect(refs).toBe("");
  });

  it("records a snapshot ref for each check while work is open", () => {
    const cwd = workspace(true);
    run(cwd, { action: "accept" });
    run(cwd, { action: "check", id: "DC-1", evidence: "observed pass" });
    const [, checked] = readSpecLog(join(cwd, LOG_PATH));
    expect(checked).toMatchObject({
      event: "checked",
      snapshot: "refs/pi-specs/greet/1",
    });
  });

  it("base snapshot: first accept records ref 0; revise keeps it", () => {
    const cwd = workspace(true);
    run(cwd, { action: "accept" });
    const [accepted] = readSpecLog(join(cwd, LOG_PATH));
    expect(accepted).toMatchObject({
      event: "accepted",
      head: null,
      snapshot: "refs/pi-specs/greet/0",
    });
    writeFileSync(join(cwd, "later.txt"), "after the base");
    writeFileSync(join(cwd, SPEC_PATH), SPEC.replace("Localization.", "i18n."));
    run(cwd, { action: "accept", revise: true });
    expect(readSpecLog(join(cwd, LOG_PATH)).at(-1)).toMatchObject({
      event: "accepted",
      snapshot: "refs/pi-specs/greet/0",
    });
    const baseFiles = execFileSync("git", [
      "-C",
      cwd,
      "ls-tree",
      "-r",
      "--name-only",
      "refs/pi-specs/greet/0",
    ]).toString();
    expect(baseFiles).toContain(SPEC_PATH);
    expect(baseFiles).not.toContain("later.txt");
  });

  it("base snapshot: a non-git workspace stores null", () => {
    const cwd = workspace();
    run(cwd, { action: "accept" });
    expect(readSpecLog(join(cwd, LOG_PATH))[0]).toMatchObject({
      head: null,
      snapshot: null,
    });
  });

  it("base snapshot: a log without base fields still parses", () => {
    const cwd = workspace();
    const content = readFileSync(join(cwd, SPEC_PATH), "utf8");
    writeFileSync(
      join(cwd, LOG_PATH),
      `${JSON.stringify({ ts: new Date().toISOString(), event: "accepted", hash: hashSpec(content), criteria: ["DC-1", "DC-2"], content })}\n`,
    );
    expect(
      run(cwd, { action: "check", id: "DC-1", evidence: "seen" }).isError,
    ).toBe(false);
  });

  it("stale: a tracked or untracked change after a check marks it [~] with files", () => {
    const cwd = workspace(true);
    writeFileSync(join(cwd, "tracked.txt"), "v1");
    execFileSync("git", ["-C", cwd, "add", "tracked.txt"]);
    run(cwd, { action: "accept" });
    run(cwd, { action: "check", id: "DC-1", evidence: "seen" });
    expect(renderSpecStatus(cwd, "greet")).toContain("- [x] DC-1");
    writeFileSync(join(cwd, "tracked.txt"), "v2");
    writeFileSync(join(cwd, "new.txt"), "untracked");
    const status = renderSpecStatus(cwd, "greet");
    expect(status).toContain("- [~] DC-1");
    expect(status).toContain("  Stale: new.txt, tracked.txt");
  });

  it("stale: .pi/specs changes never count, even without .gitignore", () => {
    const cwd = workspace(true);
    run(cwd, { action: "accept" });
    run(cwd, { action: "check", id: "DC-1", evidence: "seen" });
    run(cwd, { action: "block", reason: "keeps the Spec open" });
    writeFileSync(join(cwd, ".pi", "specs", "other.md"), "x");
    const status = renderSpecStatus(cwd, "greet");
    expect(status).toContain("- [x] DC-1");
    expect(status).not.toContain("Stale:");
  });

  it("stale: checking DC-1 then DC-2 leaves DC-1 unchanged in a repo with no .gitignore", () => {
    const cwd = workspace(true);
    run(cwd, { action: "accept" });
    run(cwd, { action: "check", id: "DC-1", evidence: "seen" });
    const after = run(cwd, { action: "check", id: "DC-2", evidence: "seen" });
    expect(after.text).not.toContain("[~]");
  });

  it("stale: a check with no snapshot shows unknown, not stale", () => {
    const cwd = workspace();
    run(cwd, { action: "accept" });
    run(cwd, { action: "check", id: "DC-1", evidence: "seen" });
    const status = renderSpecStatus(cwd, "greet");
    expect(status).toContain("- [x] DC-1");
    expect(status).toContain("  Stale: unknown (no snapshot to compare)");
  });

  it("stale: a done Spec shows no stale marks", () => {
    const cwd = workspace(true);
    run(cwd, { action: "accept" });
    run(cwd, { action: "check", id: "DC-1", evidence: "seen" });
    run(cwd, { action: "check", id: "DC-2", evidence: "seen" });
    run(cwd, {
      action: "verify",
      verdict: "pass",
      findings: 0,
      evidence: "dc-verifier run: all PASS",
    });
    writeFileSync(join(cwd, "late.txt"), "after done");
    const status = renderSpecStatus(cwd, "greet");
    expect(status).toContain("Status: done");
    expect(status).not.toContain("[~]");
    expect(status).not.toContain("Stale:");
  });

  const checkAll = (cwd: string) => {
    run(cwd, { action: "accept" });
    run(cwd, { action: "check", id: "DC-1", evidence: "seen" });
    run(cwd, { action: "check", id: "DC-2", evidence: "seen" });
  };
  const PASS = {
    action: "verify",
    verdict: "pass",
    findings: 0,
    evidence: "dc-verifier: all PASS",
  };
  const logLength = (cwd: string) => readSpecLog(join(cwd, LOG_PATH)).length;

  it("verify: fails and writes nothing while a criterion is open", () => {
    const cwd = workspace(true);
    run(cwd, { action: "accept" });
    run(cwd, { action: "check", id: "DC-1", evidence: "seen" });
    const before = logLength(cwd);
    const outcome = run(cwd, PASS);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("open or blocked: DC-2");
    expect(logLength(cwd)).toBe(before);
  });

  it("verify: fails and writes nothing on a changed Spec, blank evidence, or missing verdict/findings", () => {
    const cwd = workspace(true);
    checkAll(cwd);
    const before = logLength(cwd);
    for (const params of [
      { ...PASS, evidence: "  " },
      { action: "verify", findings: 0, evidence: "x" },
      { action: "verify", verdict: "pass", evidence: "x" },
    ]) {
      expect(run(cwd, params).isError).toBe(true);
    }
    writeFileSync(join(cwd, SPEC_PATH), SPEC.replace("Localization.", "i18n."));
    expect(run(cwd, PASS).text).toContain("changed since acceptance");
    expect(logLength(cwd)).toBe(before);
  });

  it("verify: issues records verified without done", () => {
    const cwd = workspace(true);
    checkAll(cwd);
    run(cwd, { ...PASS, verdict: "issues", findings: 2 });
    const tail = readSpecLog(join(cwd, LOG_PATH)).at(-1);
    expect(tail).toMatchObject({
      event: "verified",
      verdict: "issues",
      findings: 2,
    });
    expect(renderSpecStatus(cwd, "greet")).toContain("Status: accepted");
  });

  it("verify: pass is refused while a criterion is stale, names it, and writes nothing", () => {
    const cwd = workspace(true);
    checkAll(cwd);
    writeFileSync(join(cwd, "src.ts"), "changed after checks");
    const before = logLength(cwd);
    const outcome = run(cwd, PASS);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("- DC-1: src.ts");
    expect(outcome.text).toContain("- DC-2: src.ts");
    expect(logLength(cwd)).toBe(before);
  });

  it("verify: pass is refused when a recorded snapshot ref is gone, and status says so", () => {
    const cwd = workspace(true);
    checkAll(cwd);
    execFileSync("git", [
      "-C",
      cwd,
      "update-ref",
      "-d",
      "refs/pi-specs/greet/1",
    ]);
    const status = renderSpecStatus(cwd, "greet");
    expect(status).toContain("- [~] DC-1");
    expect(status).toContain(
      "  Stale: error: cannot compare with refs/pi-specs/greet/1",
    );
    const before = logLength(cwd);
    const outcome = run(cwd, PASS);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain(
      "- DC-1: error: cannot compare with refs/pi-specs/greet/1",
    );
    expect(logLength(cwd)).toBe(before);
  });

  it("verify: a check after verify uses a new ref, then verify pass writes done", () => {
    const cwd = workspace(true);
    checkAll(cwd);
    run(cwd, { ...PASS, verdict: "issues", findings: 1 });
    writeFileSync(join(cwd, "fix.ts"), "repair");
    run(cwd, { action: "check", id: "DC-1", evidence: "re-run" });
    run(cwd, { action: "check", id: "DC-2", evidence: "re-run" });
    const events = readSpecLog(join(cwd, LOG_PATH));
    expect(events.find((event) => event.event === "verified")).toMatchObject({
      snapshot: "refs/pi-specs/greet/3",
    });
    expect(events.at(-2)).toMatchObject({
      event: "checked",
      snapshot: "refs/pi-specs/greet/4",
    });
    expect(run(cwd, PASS).isError).toBe(false);
    expect(readSpecLog(join(cwd, LOG_PATH)).at(-1)?.event).toBe("done");
    expect(
      execFileSync("git", [
        "-C",
        cwd,
        "for-each-ref",
        "refs/pi-specs/",
      ]).toString(),
    ).toBe("");
  });

  it("refuses accept on lint failure and check before accept", () => {
    const cwd = workspace();
    expect(
      run(cwd, { action: "check", id: "DC-1", evidence: "x" }).text,
    ).toContain("requires an accepted Spec");
    writeFileSync(join(cwd, SPEC_PATH), SPEC.replace("## Plan\n", ""));
    expect(run(cwd, { action: "accept" }).text).toContain("Spec lint failed");
  });

  it("requires user-approved revise after the accepted text changes, then reopens criteria", () => {
    const cwd = workspace();
    run(cwd, { action: "accept" });
    run(cwd, { action: "check", id: "DC-1", evidence: "observed pass" });
    writeFileSync(join(cwd, SPEC_PATH), SPEC.replace("Localization.", "i18n."));
    const blocked = run(cwd, {
      action: "check",
      id: "DC-2",
      evidence: "observed",
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("+i18n.");
    const refused = run(cwd, { action: "accept" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("revise: true");
    const revised = run(cwd, { action: "accept", revise: true });
    expect(revised.isError).toBe(false);
    expect(renderSpecStatus(cwd, "greet")).toContain("- [ ] DC-1");
  });

  it("blocks accept after a revise or stop review of the same text", () => {
    const cwd = workspace();
    run(cwd, { action: "review", decision: "revise", findings: 2 });
    expect(run(cwd, { action: "accept" }).isError).toBe(true);
    run(cwd, { action: "review", decision: "accept", findings: 2 });
    expect(run(cwd, { action: "accept" }).isError).toBe(false);
  });

  it("records blockers and stop, then refuses further events", () => {
    const cwd = workspace();
    run(cwd, { action: "accept" });
    run(cwd, { action: "block", id: "DC-2", reason: "needs credentials" });
    expect(renderSpecStatus(cwd, "greet")).toContain(
      "- [!] DC-2: repository check passes (technical)",
    );
    run(cwd, { action: "stop", reason: "user stopped" });
    expect(
      run(cwd, { action: "check", id: "DC-1", evidence: "x" }).isError,
    ).toBe(true);
  });

  it("treats a pre-P4 log as legacy and refuses to resume it", () => {
    const cwd = workspace();
    writeFileSync(
      join(cwd, LOG_PATH),
      `${JSON.stringify({ ts: new Date().toISOString(), event: "accepted", hash: "a".repeat(64), invocationId: "x", assignments: [] })}\n`,
    );
    const outcome = run(cwd, { action: "accept" });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("predates the spec_log tool");
    expect(renderSpecStatus(cwd)).toContain("greet  legacy (pre-P4): accepted");
  });

  it("rejects log events with a bad timestamp, extra field, or wrong type", () => {
    const cwd = workspace();
    const ts = new Date().toISOString();
    for (const event of [
      { ts: "yesterday", event: "done" },
      { ts, event: "done", extra: 1 },
      { ts, event: "blocked", reason: "" },
      {
        ts,
        event: "reviewed",
        hash: "a".repeat(64),
        decision: "ok",
        findings: 0,
      },
    ]) {
      writeFileSync(join(cwd, LOG_PATH), `${JSON.stringify(event)}\n`);
      expect(() => readSpecLog(join(cwd, LOG_PATH))).toThrow(
        "predates the spec_log tool",
      );
    }
    writeFileSync(
      join(cwd, LOG_PATH),
      `${JSON.stringify({ ts, event: "accepted", hash: "a".repeat(64), criteria: ["DC-1"], content: SPEC })}\n`,
    );
    expect(readSpecLog(join(cwd, LOG_PATH))).toHaveLength(1);
  });

  it("rejects paths outside .pi/specs", () => {
    const cwd = workspace();
    expect(
      runSpecLog(cwd, { action: "status", specPath: "../x.md" }).isError,
    ).toBe(true);
    expect(readFileSync(join(cwd, SPEC_PATH), "utf8")).toBe(SPEC);
  });
});

describe("spec_log rendering", () => {
  initTheme("dark");
  const view = (text: string, expanded = true) =>
    new SpecLogResult(
      text,
      (segment) => segment,
      expanded,
      (count) => `+${count}`,
    )
      .render(80)
      .map((line) => stripVTControlCharacters(line).trimEnd());

  it("labels the call with action, slug, and criterion", () => {
    expect(
      specLogCallLabel({
        action: "check",
        specPath: "@.pi/specs/greet.md",
        id: "DC-2",
      }),
    ).toBe("check greet DC-2");
  });

  it("renders status as Markdown and keeps blockers out of the last item", () => {
    const cwd = workspace();
    run(cwd, { action: "accept" });
    run(cwd, { action: "block", id: "DC-2", reason: "needs `creds`" });
    run(cwd, { action: "block", reason: "waiting on user" });
    const lines = view(renderSpecStatus(cwd, "greet"));
    expect(lines).toContain("  Blocked: needs creds");
    expect(lines).toContain("Blocker: waiting on user");
  });

  it("renders revision diffs as a fenced diff block", () => {
    const cwd = workspace();
    run(cwd, { action: "accept" });
    writeFileSync(join(cwd, SPEC_PATH), SPEC.replace("Localization.", "i18n."));
    const text = run(cwd, { action: "accept" }).text;
    expect(text).toContain("```diff\n");
    const lines = view(text);
    expect(lines).toContain("```diff");
    expect(lines.some((line) => line.trim() === "+i18n.")).toBe(true);
  });

  it("keeps the diff fenced when the Spec has its own code fence", () => {
    const fenced = SPEC.replace(
      "Localization.",
      "```\ncode\n```\nLocalization.",
    );
    const cwd = workspace();
    writeFileSync(join(cwd, SPEC_PATH), fenced);
    run(cwd, { action: "accept" });
    writeFileSync(
      join(cwd, SPEC_PATH),
      fenced.replace("Localization.", "i18n."),
    );
    const lines = view(run(cwd, { action: "accept" }).text);
    // Inside a code block, diff lines keep the block's indent; as prose they do not.
    expect(lines).toContain("  -Localization.");
    expect(lines).toContain("  +i18n.");
  });

  it("collapses long results until expanded", () => {
    const text = Array.from({ length: 30 }, (_, index) => `line ${index}`).join(
      "\n\n",
    );
    expect(view(text, false).at(-1)).toMatch(/^\+\d+$/u);
    expect(view(text, true).some((line) => line.startsWith("+"))).toBe(false);
  });
});
