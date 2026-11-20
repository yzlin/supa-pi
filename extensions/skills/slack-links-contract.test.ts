import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("slack-links skill contract (wiring, not model adherence)", () => {
  const skill = read("skills/slack-links/SKILL.md");

  it("restates the underlying issue after retrieval, before failures", () => {
    const retrieve = skill.indexOf("## Retrieve");
    const restate = skill.indexOf("## Restate");
    const failures = skill.indexOf("## Failures");
    expect(retrieve).toBeGreaterThan(0);
    expect(restate).toBeGreaterThan(retrieve);
    expect(failures).toBeGreaterThan(restate);
    expect(skill).toContain(
      "open the reply with a line that starts with `Issue: `",
    );
    expect(skill).toContain("Label each inference as an inference.");
  });

  it("feeds triage step 1 instead of a second restatement", () => {
    expect(skill).toContain(
      "this `Issue:` line is the triage Playbook's step 1 restatement",
    );
    expect(read("skills/supapi-mode/playbooks/triage.md")).toContain(
      "1. Restate the underlying issue in plain words, in one line that starts with `Issue: `.",
    );
  });
});
