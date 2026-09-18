import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const skillDirectory = join(process.cwd(), "skills", "wayfinder");
const readResource = (path: string): string =>
  readFileSync(join(skillDirectory, path), "utf8");

describe("wayfinder skill resources", () => {
  it("loads through Pi's actual skill loader without diagnostics", () => {
    const result = loadSkillsFromDir({
      dir: skillDirectory,
      source: "wayfinder-contract-test",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: "wayfinder",
      disableModelInvocation: false,
    });
  });

  it("ships coherent map and question templates", () => {
    const map = readResource("templates/MAP.md");
    const question = readResource("templates/QUESTION.md");

    for (const heading of [
      "# Wayfinder map:",
      "## Destination",
      "## Ownership and checkpoint",
      "## Question order",
      "## Not yet specified",
      "## Out of scope",
      "## Decision handoff",
    ]) {
      expect(map).toContain(heading);
    }
    expect(map).toContain("questions/<stable-slug>.md");
    expect(map).not.toContain("## Answer");

    for (const field of [
      "Type: research | grilling | prototype | prerequisite-task",
      "Status: unresolved | resolved | excluded",
      "Depends on:",
      "## Answer versions",
      "## Revision history",
      "## Approval",
      "Approval status: pending | granted | invalidated",
      "Human approval reference/timestamp:",
      "Approved scope/version:",
      "## Verification and feedback",
    ]) {
      expect(question).toContain(field);
    }
  });

  it("documents the locked safety, ownership, and completion scenarios", () => {
    const skill = readResource("SKILL.md");
    const scenarios = readResource("references/scenarios.md");

    for (const contract of [
      "question record is authoritative",
      "first ready question in explicit map order",
      "enumerate compact headers from every question file",
      "Status: unresolved",
      "pending revalidation is a checkpoint reason, not a question status",
      "human owns preferences, scope, and tradeoffs",
      "No implementation or automatic `/execute`",
      "explicit approval before taking over",
      "reject traversal and symlink escapes",
      "git check-ignore",
      "narrow ignore exception",
      "all filled action fields alone are not consent",
      "both map and claimed question headers",
      "context-docs",
    ]) {
      expect(skill).toContain(contract);
    }

    for (const scenario of [
      "Sole resumable map",
      "Ambiguous resume",
      "Interrupted claim",
      "Decision revision",
      "Excluded dependency",
      "Inconsistent incremental write",
      "Prototype scope change",
      "Ignored storage",
      "Approval is not inferred",
      "Interrupted completed-map revision",
      "Interrupted question creation",
      "Completion with fog",
    ]) {
      expect(scenarios).toContain(`### ${scenario}`);
    }
  });

  it("retains pinned upstream attribution and its MIT notice", () => {
    const skill = readResource("SKILL.md");
    const notice = readResource("LICENSE.upstream");

    expect(skill).toContain("74ca5fe077456a0b3b2f5310cf9430999fd0b5fd");
    expect(notice).toContain("MIT License");
    expect(notice).toContain("Copyright (c) 2026 Matt Pocock");
  });
});
