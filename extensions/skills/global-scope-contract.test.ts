import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = process.cwd();
const globalAgentsPath = join(repositoryRoot, "AGENTS.global.md");
const developmentWorkflowPath = join(
  repositoryRoot,
  "rules",
  "common",
  "development-workflow.md",
);
const tddWorkflowPath = join(
  repositoryRoot,
  "skills",
  "tdd-workflow",
  "SKILL.md",
);

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

function readGlobalAgents(): string {
  return readFile(globalAgentsPath);
}

function section(
  document: string,
  heading: string,
  nextHeading?: string,
): string {
  const start = document.indexOf(`${heading}\n`);
  const end = nextHeading ? document.indexOf(`\n${nextHeading}\n`, start) : -1;

  expect(start).toBeGreaterThanOrEqual(0);
  if (nextHeading) {
    expect(end).toBeGreaterThan(start);
  }

  return document.slice(start, end === -1 ? undefined : end).trimEnd();
}

const expectedAgentProtocol = `## Agent Protocol

- Guardrails: use \`trash\` for deletes.
- Bugs: add regression test when it fits.
- Editor: \`zed <path>\`.
- Prefer the narrowest sufficient proof; use end-to-end verification where boundaries need it. If blocked, say what’s missing.
- Before non-trivial coding: state assumptions, material ambiguities, and done criteria.
- Style: telegraph. Drop filler/grammar. Min tokens (global AGENTS + replies).
- Make the smallest complete change requested; every changed line must serve that scope. Explicitly requested broad refactors are allowed, but no unrelated or drive-by refactors.
- Do not add abstractions, configuration, flexibility, or future-proofing unless the requested change needs them.`;

const expectedUnrelatedSections = `## Docs

- Discover relevant docs when the task needs unfamiliar project or domain context, or scoped instructions require it. Use \`docs_list\` when available; otherwise use the local docs-list command or equivalent search.
- Skip discovery for obvious typos, mechanical edits, and already-understood local changes unless scoped instructions require it.
- Read docs whose summaries or \`read_when\` hints match the task; follow links only to resolve task-relevant gaps.
- Keep notes short; update docs when behavior/API changes (no ship w/o docs).
- Add \`read_when\` hints on cross-cutting docs.

## Critical Thinking

- Fix root cause (not band-aid).
- Repo-owned contracts: remove obsolete paths; no indefinite compatibility layers. Runtime, external, or persisted-state compatibility needs a stated reason and removal trigger.
- Unsure: read more code; if still stuck, ask w/ short options.
- If multiple materially different interpretations exist, do not choose silently; ask or list options.
- Conflicts: call out; pick safer path.
- Unrecognized changes: assume other agent; keep going; focus your changes. If it causes issues, stop + ask user.
- Leave breadcrumb notes in thread.

## Evidence baseline

- Verify code, files, flags, and current behavior before fixing or recommending from memory.
- Do not invent citations, URLs, file references, or facts.
- If a claim is uncertain or unverified, say so explicitly.
- Distinguish clearly between verified facts, informed inferences, and hypotheses.
- For factual claims about the codebase, prefer grounding in actual files.
- For factual claims about external tools/libraries, prefer official docs or directly cited sources.

## Tools

### edit

- Do not use Python scripts to edit files. Use the built-in \`edit\` tool for targeted file changes.

### trash

- Move files to Trash: \`trash …\` (system command).`;

describe("global scope instruction contract", () => {
  it("keeps one compact owner for requested scope and implementation restraint", () => {
    const agentProtocol = section(
      readGlobalAgents(),
      "## Agent Protocol",
      "## Docs",
    );

    expect(agentProtocol).toBe(expectedAgentProtocol);
    expect(agentProtocol.match(/^- Make |^- Do not add/gm)).toHaveLength(2);
  });

  it("preserves conditional docs discovery and neighboring global policies", () => {
    const document = readGlobalAgents();

    expect(section(document, "## Docs")).toBe(expectedUnrelatedSections);
  });

  it("uses the narrowest sufficient proof and reserves E2E for needed boundaries", () => {
    const document = readGlobalAgents();

    expect(document).toContain(
      "Prefer the narrowest sufficient proof; use end-to-end verification where boundaries need it.",
    );
    expect(document).not.toContain("Prefer end-to-end verify;");
  });

  it("validates intermediate phases without requiring an end-to-end path for each one", () => {
    const workflow = readFile(developmentWorkflowPath);

    expect(workflow).toContain(
      "For phased work, validate each intermediate phase; the final requested outcome must be usable.",
    );
    expect(workflow).not.toContain(
      "For phased work, each phase must leave a usable, verified end-to-end path.",
    );
  });

  it("bounds a RED alternative to reversible low-impact work", () => {
    const workflow = readFile(tddWorkflowPath);

    for (const requirement of [
      "Continue without a meaningful RED only",
      "reversible, low-impact change",
      "concrete alternative verification",
      "explain why a meaningful RED is unavailable",
      "Never fabricate a RED",
      "stop and report a blocker",
      "Meaningful regression coverage",
      "relevant failure-path coverage",
      "required repository checks remain mandatory",
      "does not apply to security, payment, data-integrity, or irreversible work",
    ]) {
      expect(workflow).toContain(requirement);
    }

    expect(workflow).not.toContain(
      "security, payment, data-integrity, or irreversible work is eligible",
    );
  });

  it("keeps honest RED evidence and independent verification", () => {
    const workflow = readFile(tddWorkflowPath);

    expect(workflow).toContain(
      "For eligible work, report `RED: unavailable because <specific reason>`",
    );
    expect(workflow).toContain(
      "the main session independently inspects the result and runs current tests",
    );
    expect(workflow).toContain(
      "`GREEN:` the command and passing result after implementation",
    );
    expect(workflow).toContain(
      "`COVERAGE:` the repository threshold/result, meaningful changed-behavior and failure-path coverage",
    );
  });
});
