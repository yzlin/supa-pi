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

import { runSpecLog } from "./index";
import { lintSpec, readSpecLog, renderSpecStatus } from "./spec";

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

describe("spec_log tool", () => {
  it("accepts, checks each criterion with evidence, and writes done", () => {
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
    const events = readSpecLog(join(cwd, LOG_PATH)).map((event) => event.event);
    expect(events).toEqual(["accepted", "checked", "checked", "done"]);
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

  it("rejects paths outside .pi/specs", () => {
    const cwd = workspace();
    expect(
      runSpecLog(cwd, { action: "status", specPath: "../x.md" }).isError,
    ).toBe(true);
    expect(readFileSync(join(cwd, SPEC_PATH), "utf8")).toBe(SPEC);
  });
});
