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
    expect(alias).toContain("skills/supapi-mode/playbooks/execute.md");
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

  it("forbids detached executors from writing the Spec log", () => {
    expect(read("agents/executor.md")).toContain(
      "disallowed_tools: spec_log, goal_checkpoint, subagent",
    );
  });
});
