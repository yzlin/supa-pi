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
- Prove it works: narrowest sufficient real proof → \`~/.pi/agent/rules/principles/prove-it-works.md\`.
- Before non-trivial coding: state assumptions, material ambiguities, and done criteria.
- Style: telegraph for global AGENTS, chat replies, progress updates. Drop filler/grammar. Min tokens. Final reports after multi-step work follow \`plain-report\`.
- Smallest complete change; no drive-by refactors → \`~/.pi/agent/rules/principles/laziness-protocol.md\`.
- No speculative abstraction/config/flexibility → \`~/.pi/agent/rules/principles/subtract-before-you-add.md\`.
- Principles: one rule per file in \`~/.pi/agent/rules/principles/\`; name the one that changed a decision.`;

const expectedUnrelatedSections = `## Docs

- Discover relevant docs when the task needs unfamiliar project or domain context, or scoped instructions require it. Use \`docs_list\` when available; otherwise use the local docs-list command or equivalent search.
- Skip discovery for obvious typos, mechanical edits, and already-understood local changes unless scoped instructions require it.
- Read docs whose summaries or \`read_when\` hints match the task; follow links only to resolve task-relevant gaps.
- Keep notes short; update docs when behavior/API changes (no ship w/o docs).
- Add \`read_when\` hints on cross-cutting docs.

## Critical Thinking

- Fix root cause, not band-aid → \`~/.pi/agent/rules/principles/fix-root-causes.md\`.
- Repo-owned contracts: migrate callers, delete old path → \`~/.pi/agent/rules/principles/migrate-callers-then-delete-legacy-apis.md\`.
- Unsure: read more code; if still stuck, ask w/ short options.
- Never choose silently: state the choice, or ask when it is irreversible or product direction → \`~/.pi/agent/rules/principles/never-block-on-the-human.md\`.
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

- Move files to Trash: \`trash …\` (system command).

### Slack links

- Slack URLs (\`*.slack.com/archives/…\`): always use the \`slack-links\` skill (executor MCP). Never web-fetch or browse them.`;

describe("global scope instruction contract", () => {
  it("keeps one compact owner for requested scope and implementation restraint", () => {
    const agentProtocol = section(
      readGlobalAgents(),
      "## Agent Protocol",
      "## Docs",
    );

    expect(agentProtocol).toBe(expectedAgentProtocol);
    expect(
      agentProtocol.match(/^- Smallest |^- No speculative/gm),
    ).toHaveLength(2);
  });

  it("preserves conditional docs discovery and neighboring global policies", () => {
    const document = readGlobalAgents();

    expect(section(document, "## Docs")).toBe(expectedUnrelatedSections);
  });

  it("moves each pointed rule into an existing Principle file that owns it", () => {
    const document = readGlobalAgents();
    const owned: Record<string, string[]> = {
      "prove-it-works": [
        "Prefer the narrowest sufficient proof; use end-to-end verification where boundaries need it.",
      ],
      "laziness-protocol": [
        "Make the smallest complete change requested; every changed line must serve that scope.",
        "unrelated or drive-by refactors are not",
      ],
      "subtract-before-you-add": [
        "Do not add abstractions, configuration, flexibility, or future-proofing unless the requested change needs them.",
      ],
      "fix-root-causes": ["Fix the fault, not the place where it surfaced."],
      "migrate-callers-then-delete-legacy-apis": [
        "No indefinite compatibility layers.",
        "needs a stated reason and a removal trigger",
      ],
      "never-block-on-the-human": [
        "Never choose silently: state the choice, or ask when it is irreversible or product direction.",
      ],
    };
    const pointers = [
      ...document.matchAll(/~\/\.pi\/agent\/rules\/principles\/([a-z-]+)\.md/g),
    ].map((match) => match[1]);

    expect(new Set(pointers)).toEqual(new Set(Object.keys(owned)));
    for (const [name, phrases] of Object.entries(owned)) {
      const principle = readFile(
        join(repositoryRoot, "rules", "principles", `${name}.md`),
      );
      for (const phrase of phrases) {
        expect(principle).toContain(phrase);
        expect(document).not.toContain(phrase);
      }
    }
    expect(document).not.toContain("Prefer end-to-end verify;");
  });

  it("validates intermediate phases without requiring an end-to-end path for each one", () => {
    const workflow = readFile(developmentWorkflowPath);

    expect(workflow).toContain(
      "For phased work, follow [outcome-oriented-execution](../principles/outcome-oriented-execution.md)",
    );
    expect(
      readFile(
        join(
          repositoryRoot,
          "rules",
          "principles",
          "outcome-oriented-execution.md",
        ),
      ),
    ).toContain("Validate each intermediate phase");
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
