import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const playbook = () => read("skills/supapi-mode/playbooks/execute.md");

describe("execute Playbook contract (wiring, not model adherence)", () => {
  it("removes the execute_checkpoint ledger and the execute skill", () => {
    expect(existsSync(join(root, "extensions", "execute"))).toBe(false);
    expect(existsSync(join(root, "skills", "execute"))).toBe(false);
    const manifest = read("package.json");
    expect(manifest).not.toContain("./extensions/execute");
    expect(manifest).toContain("./extensions/spec-log");
    expect(playbook()).not.toContain("execute_checkpoint");
  });

  it("keeps /execute a thin alias to the Playbook", () => {
    const alias = read("prompts/execute.md");
    expect(alias).toContain(
      "open `playbooks/execute.md` in the directory of the `supapi-mode` location",
    );
    expect(alias.split("\n").length).toBeLessThan(16);
  });

  it("states the prose gates that replaced runtime enforcement", () => {
    const text = playbook();
    for (const gate of [
      "`spec_log` is the only writer",
      "Run its named evidence yourself after the last edit",
      "A child's validation list is not your evidence",
      "at most two repair attempts after its first try",
      "Read-only re-verification is not a repair",
      "Never record intent or a child's claim as evidence",
      "explicit user approval that names them",
      "Run at most four children at once, only across disjoint scopes",
      "Never present a blocked or open criterion as done",
      "a blocker found before acceptance is not logged. Do not accept",
    ]) {
      expect(text).toContain(gate);
    }
  });

  it("reads executor reports from the tool result, not result.json", () => {
    const text = playbook();
    expect(text).toContain(
      '"Validated StructuredOutput" JSON in the tool result',
    );
    expect(text).not.toContain("structuredContent");
  });

  it("keeps goal task-mode docs on the model-visible report", () => {
    const readme = read("extensions/goal/README.md");
    expect(readme).toContain(
      '"Validated StructuredOutput" JSON in the tool result',
    );
    expect(readme).not.toContain("structuredContent.structuredOutput");
  });

  it("reviews a Spec with two spec-reviewers and records the decision", () => {
    const text = playbook();
    expect(text).toContain("agent `spec-reviewer`");
    expect(text).toContain("../schemas/spec-review.schema.json");
    expect(text).toContain("`spec_log` `review`");
    expect(text).toContain("At most two review rounds per Spec");
    expect(text).not.toContain("classifier");
  });

  it("ships the schemas the Playbook names", () => {
    for (const name of ["executor-report", "spec-review"]) {
      const schema = JSON.parse(
        read(`skills/supapi-mode/schemas/${name}.schema.json`),
      );
      expect(schema.additionalProperties).toBe(false);
    }
    const executor = JSON.parse(
      read("skills/supapi-mode/schemas/executor-report.schema.json"),
    );
    expect(executor.required).toEqual([
      "status",
      "summary",
      "filesTouched",
      "validation",
      "followUps",
      "blockers",
    ]);
    expect(playbook()).toContain("../schemas/executor-report.schema.json");
  });

  it("carries each Spec review question's problem and per-option effects", () => {
    const schema = JSON.parse(
      read("skills/supapi-mode/schemas/spec-review.schema.json"),
    );
    const question = schema.properties.questions.items;
    expect(question.required).toEqual([
      "id",
      "question",
      "problem",
      "evidence",
      "options",
    ]);
    expect(question.additionalProperties).toBe(false);
    const option = question.properties.options.items;
    expect(option.type).toBe("object");
    expect(option.required).toEqual([
      "label",
      "effect",
      "affects",
      "reversible",
    ]);
    expect(option.additionalProperties).toBe(false);
    expect(option.properties.affects.type).toBe("array");
    expect(option.properties.reversible.type).toBe("boolean");
  });

  it("builds a Decision brief from each reviewer question", () => {
    const text = playbook();
    expect(text).toContain("Decision brief");
    expect(text).toContain("`problem`, `evidence`");
  });

  it("forbids detached executors from writing the Spec log", () => {
    expect(read("agents/executor.md")).toContain(
      "disallowed_tools: spec_log, goal_checkpoint, subagent",
    );
  });

  it("defines a read-only dc-verifier", () => {
    const agent = read("agents/dc-verifier.md");
    for (const line of [
      "tools: read, grep, find, ls, bash",
      "extensions: false",
      "skills: false",
      "disallowed_tools: spec_log, goal_checkpoint, subagent",
      "model: claude-code/claude-opus-5-5",
      "thinking: high",
    ]) {
      expect(agent).toContain(line);
    }
    for (const rule of [
      "Never edit, create, move, or delete files in the workspace",
      "Write only under the artifact directory",
      "$TMPDIR/pi-verify/<slug>/",
      'git worktree add --detach "$TMPDIR/pi-verify/<slug>/base" <snapshot>',
      "symlink the workspace's `node_modules`",
      "git worktree remove --force",
      "defects that no Done Criterion states",
      "Block only on a problem you can show",
      "A problem the base already has does not block",
      "Report every issue you can prove",
    ]) {
      expect(agent).toContain(rule);
    }
    for (const other of ["executor", "spec-reviewer", "code-reviewer"]) {
      expect(read(`agents/${other}.md`)).not.toContain("model: openai-codex");
    }
  });

  it("orders Finish: gate, check, re-check all, dc-verifier, verify", () => {
    const finish =
      playbook().split("## 7. Finish")[1]?.split("**Principles:**")[0] ?? "";
    const order = [
      "Run the review gate",
      "Run `bun run check`",
      "Re-check every Done Criterion",
      "Record `git status --porcelain --untracked-files=all`",
      "agent `dc-verifier` and `schema` from `../schemas/dc-verify.schema.json`",
      "Revert and report any workspace change the verifier made",
      "Re-read every `ISSUES`",
      "Call `spec_log` `verify`",
    ].map((step) => finish.indexOf(step));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const rule of [
      "the last `check` is not",
      "`spec_log` `status` must show no `[~]`",
      "at most two verifier rounds after the first",
      "The verifier's `blocked` goes to `spec_log` `block`",
      "re-`check` every criterion",
    ]) {
      expect(finish).toContain(rule);
    }
    expect(playbook()).not.toContain(
      "`spec_log` writes `done` when every criterion is checked",
    );
  });

  it("ships the dc-verify report schema", () => {
    const schema = JSON.parse(
      read("skills/supapi-mode/schemas/dc-verify.schema.json"),
    ) as {
      required: string[];
      properties: Record<
        string,
        { enum?: string[]; items?: { required: string[] } }
      >;
    };
    expect(schema.required).toEqual([
      "verdict",
      "criteria",
      "lanes",
      "findings",
    ]);
    expect(schema.properties.verdict?.enum).toEqual([
      "pass",
      "issues",
      "blocked",
    ]);
    expect(schema.properties.criteria?.items?.required).toEqual([
      "id",
      "result",
      "evidence",
    ]);
    expect(schema.properties.lanes?.items?.required).toEqual([
      "id",
      "result",
      "artifact",
      "evidence",
    ]);
    expect(schema.properties.findings?.items?.required).toEqual([
      "id",
      "target",
      "why",
      "evidence",
    ]);
  });
});
