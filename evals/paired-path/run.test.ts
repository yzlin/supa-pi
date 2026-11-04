import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CASES } from "./cases";
import {
  buildHome,
  mainToolEvents,
  parseArgs,
  score,
  seedWorkspace,
} from "./run";

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "paired-path-"));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const byId = (id: string) => {
  const found = CASES.find((c) => c.id === id);
  if (!found) {
    throw new Error(id);
  }
  return found;
};

function session(dir: string, entries: unknown[]) {
  const sessions = join(dir, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, "s.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n"),
  );
}
const call = (id: string, name: string, args: unknown) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
  },
});
const result = (id: string, isError = false) => ({
  type: "message",
  message: { role: "toolResult", toolCallId: id, isError },
});
const say = (text: string) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

describe("paired-path runner (offline)", () => {
  it("plans without model calls unless --live", () => {
    const options = parseArgs(["--repetitions", "2"]);
    expect(options.live).toBe(false);
    expect(() => parseArgs(["--case", "nope"])).toThrow("unknown case");
  });

  it("seeds a git repo with a dirty overlay", () => {
    const ws = join(temp(), "ws");
    seedWorkspace(ws, byId("review-seeded-bugs"));
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: ws,
      encoding: "utf8",
    }).stdout;
    expect(status.trim()).toBe("M src/auth.ts");
  });

  it("points every repo-owned agent resource at the chosen worktree", () => {
    const dir = temp();
    const worktree = join(dir, "wt");
    mkdirSync(worktree);
    const { agent } = buildHome(join(dir, "home"), worktree, join(dir, "ws"));
    for (const name of ["agents", "prompts", "rules", "themes"]) {
      expect(readlinkSync(join(agent, name))).toBe(join(worktree, name));
    }
    expect(readlinkSync(join(agent, "extensions", "supa-pi"))).toBe(worktree);
    expect(readlinkSync(join(agent, "AGENTS.md"))).toBe(
      join(worktree, "AGENTS.global.md"),
    );
    expect(existsSync(join(dir, "home", "claude"))).toBe(true);
  });

  it("orders tool calls and keeps error flags", () => {
    const dir = temp();
    session(dir, [
      call("a", "edit", {}),
      result("a"),
      call("b", "bash", { command: "bun test" }),
      result("b", true),
    ]);
    const events = mainToolEvents(join(dir, "sessions"));
    expect(events.map((e) => [e.name, e.order, e.isError])).toEqual([
      ["edit", 0, false],
      ["bash", 1, true],
    ]);
  });

  it("scores an execute run: probe, scope, done log, verification after the last edit", () => {
    const testCase = byId("execute-spec-small");
    const dir = temp();
    const ws = join(dir, "ws");
    seedWorkspace(ws, testCase);
    writeFileSync(
      join(ws, "src/math.ts"),
      "export const add = (a: number, b: number) => a + b;\nexport const multiply = (a: number, b: number) => a * b;\nexport const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));\n",
    );
    writeFileSync(
      join(ws, ".pi/specs/math-fix.log.jsonl"),
      `${JSON.stringify({ event: "done" })}\n`,
    );
    session(dir, [
      call("a", "edit", {}),
      result("a"),
      call("b", "bash", { command: "bun test tests/math.test.ts" }),
      result("b"),
    ]);
    expect(score(testCase, dir, ws)).toEqual({
      "tests-pass": true,
      "clamp-correct": true,
      scope: true,
      "log-done": true,
      "main-verified": true,
    });
  });

  it("accepts an old-arm completed ledger as recorded completion", () => {
    const testCase = byId("execute-inline-plan");
    const dir = temp();
    const ws = join(dir, "ws");
    seedWorkspace(ws, testCase);
    session(dir, [
      {
        type: "custom",
        customType: "execute-ledger-v1",
        data: { assignments: [{ status: "completed" }] },
      },
    ]);
    expect(score(testCase, dir, ws)["log-done"]).toBe(true);
    session(dir, [
      {
        type: "custom",
        customType: "execute-ledger-v1",
        data: { assignments: [{ status: "running" }] },
      },
    ]);
    expect(score(testCase, dir, ws)["log-done"]).toBe(false);
  });

  it("fails main-verified when the only test ran before the child or edit", () => {
    const testCase = byId("execute-spec-small");
    const dir = temp();
    const ws = join(dir, "ws");
    seedWorkspace(ws, testCase);
    session(dir, [
      call("a", "bash", { command: "bun test" }),
      result("a"),
      call("b", "subagent", {}),
      result("b"),
    ]);
    const checks = score(testCase, dir, ws);
    expect(checks["main-verified"]).toBe(false);
    expect(checks["clamp-correct"]).toBe(false);
    expect(checks["log-done"]).toBe(false);
  });

  it("scores review findings from report text and an unchanged tree", () => {
    const testCase = byId("review-seeded-bugs");
    const dir = temp();
    const ws = join(dir, "ws");
    seedWorkspace(ws, testCase);
    session(dir, [
      say(
        "High: DEBUG bypass. role.includes('admin') matches substrings. SQL injection in projectQuery.",
      ),
    ]);
    expect(score(testCase, dir, ws)).toEqual({
      "finds-debug-bypass": true,
      "finds-role-substring": true,
      "finds-sql-injection": true,
      "no-edits": true,
    });
    session(dir, [
      say('P1: The admin check matches any role that contains "admin".'),
    ]);
    expect(score(testCase, dir, ws)["finds-role-substring"]).toBe(true);
    writeFileSync(join(ws, "src/auth.ts"), "export {};\n");
    expect(score(testCase, dir, ws)["no-edits"]).toBe(false);
  });

  it("flags a false blocker on the clean review", () => {
    const testCase = byId("review-clean");
    const dir = temp();
    const ws = join(dir, "ws");
    seedWorkspace(ws, testCase);
    session(dir, [
      say(
        "## Findings\n- Code looks good.\n\n## Human Reviewer Callouts (Non-Blocking)\nThe review passed with no blocking findings. No critical or high findings.",
      ),
    ]);
    expect(score(testCase, dir, ws)["no-false-blocker"]).toBe(true);
    session(dir, [say("| 1 | P2 | nit | `src/search.ts:3` |")]);
    expect(score(testCase, dir, ws)["no-false-blocker"]).toBe(true);
    for (const blocker of [
      "| 1 | P1 | limit can be negative | `src/search.ts:3` |",
      "### 1. [P0] limit can be negative",
      "### 1. P1: limit can be negative",
      "- **Priority:** High",
    ]) {
      session(dir, [say(blocker)]);
      expect(score(testCase, dir, ws)["no-false-blocker"]).toBe(false);
    }
    session(dir, [say("Critical: limit can be negative.")]);
    expect(score(testCase, dir, ws)["no-false-blocker"]).toBe(false);
  });

  it("ships fixtures whose own tests describe the target behavior", () => {
    for (const id of ["execute-spec-small", "review-clean"]) {
      const testCase = byId(id);
      const ws = join(temp(), "ws");
      seedWorkspace(ws, testCase);
      const run = spawnSync("bun", ["test"], { cwd: ws, encoding: "utf8" });
      // The execute fixture starts broken (add subtracts); the clean review passes.
      expect(run.status === 0).toBe(id === "review-clean");
    }
  });
});
