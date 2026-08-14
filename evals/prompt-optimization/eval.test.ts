import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { changedPromptPaths, snapshotPromptCandidates } from "./cli";
import {
  aggregateVariants,
  CORE_EVAL_BASE_PROMPT,
  composePrompt,
  createEmptyMetrics,
  loadPromptPair,
  parseCorpus,
  reduceRunEvent,
  scoreRun,
  snapshotWorkspace,
} from "./index";

const temporaryDirectories: string[] = [];
const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "supa-pi-eval-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function run(cwd: string, command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString());
  }
}

function scoreOutput(
  output: string,
  checks: Parameters<typeof scoreRun>[1]
): ReturnType<typeof scoreRun> {
  return scoreRun(
    { output, workspace: createTemporaryDirectory(), toolCalls: [] },
    checks
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("parseCorpus", () => {
  it("accepts a valid fixed corpus", () => {
    const corpus = parseCorpus({
      version: 1,
      cases: [
        {
          id: "explain",
          workload: "explanation",
          promptPath: "extensions/core-prompt/prompt.md",
          task: "Explain the bug.",
          tools: ["read"],
          checks: [
            {
              type: "outputIncludes",
              value: "src/math.ts",
              domain: "evidence",
              weight: 1,
            },
          ],
        },
      ],
    });

    expect(corpus.cases[0]?.id).toBe("explain");
  });

  it.each([
    "diagnose",
    "showing-me",
  ])("accepts the %s skill prompt", (skillName) => {
    const promptPath = `skills/${skillName}/SKILL.md`;
    const corpus = parseCorpus({
      version: 1,
      cases: [
        {
          id: skillName,
          workload: "explanation",
          promptPath,
          task: "Explain the topic.",
          tools: [],
          checks: [
            {
              type: "outputIncludes",
              value: "topic",
              domain: "quality",
              weight: 1,
            },
          ],
        },
      ],
    });

    expect(corpus.cases[0]?.promptPath).toBe(promptPath);
  });

  it("rejects unlisted skill prompts", () => {
    expect(() =>
      parseCorpus({
        version: 1,
        cases: [
          {
            id: "other-skill",
            workload: "explanation",
            promptPath: "skills/other/SKILL.md",
            task: "Explain.",
            tools: ["read"],
            checks: [
              {
                type: "outputIncludes",
                value: "evidence",
                domain: "evidence",
                weight: 1,
              },
            ],
          },
        ],
      })
    ).toThrow("promptPath must target a SupaPi prompt");
  });

  it("rejects duplicate case ids", () => {
    const repeatedCase = {
      id: "same",
      workload: "explanation",
      promptPath: "agents/explorer.md",
      task: "Find evidence.",
      tools: ["read"],
      checks: [
        {
          type: "outputIncludes",
          value: "evidence",
          domain: "evidence",
          weight: 1,
        },
      ],
    };

    expect(() =>
      parseCorpus({ version: 1, cases: [repeatedCase, repeatedCase] })
    ).toThrow("duplicate case id");
  });

  it("rejects case ids that can escape artifact directories", () => {
    expect(() =>
      parseCorpus({
        version: 1,
        cases: [
          {
            id: "../../escape",
            workload: "explanation",
            promptPath: "agents/explorer.md",
            task: "Explain.",
            tools: ["read"],
            checks: [
              {
                type: "outputIncludes",
                value: "evidence",
                domain: "evidence",
                weight: 1,
              },
            ],
          },
        ],
      })
    ).toThrow("safe for artifact filenames");
  });

  it("rejects unsafe prompt paths and empty checks", () => {
    expect(() =>
      parseCorpus({
        version: 1,
        cases: [
          {
            id: "unsafe",
            workload: "explanation",
            promptPath: "../prompt.md",
            task: "Explain.",
            tools: [],
            checks: [],
          },
        ],
      })
    ).toThrow("promptPath");
  });
});

describe("committed corpus", () => {
  it("covers all seven target workloads and all current prompt targets", () => {
    const corpus = parseCorpus(
      JSON.parse(readFileSync(join(moduleDirectory, "corpus.json"), "utf8"))
    );
    expect(new Set(corpus.cases.map((evalCase) => evalCase.workload))).toEqual(
      new Set([
        "explanation",
        "focused bug fix",
        "multi-file implementation",
        "codebase exploration",
        "code review",
        "web research",
        "tool-heavy orchestration",
      ])
    );
    const coveredPaths = new Set(
      corpus.cases.map((evalCase) => evalCase.promptPath)
    );
    const expectedPaths = [
      "extensions/core-prompt/prompt.md",
      "architect",
      "build-error-resolver",
      "code-reviewer",
      "code-simplifier",
      "database-reviewer",
      "doc-updater",
      "e2e-runner",
      "executor",
      "executor-output-repair",
      "explorer",
      "performance-reviewer",
      "planner",
      "refactor-cleaner",
      "researcher",
      "review-verifier",
      "security-reviewer",
      "tdd-guide",
    ].map((path) => (path.endsWith(".md") ? path : `agents/${path}.md`));
    expectedPaths.push(
      "skills/diagnose/SKILL.md",
      "skills/showing-me/SKILL.md"
    );
    expect(coveredPaths).toEqual(new Set(expectedPaths));
  });

  it("accepts focused show-me output shapes", async () => {
    const corpus = parseCorpus(
      JSON.parse(readFileSync(join(moduleDirectory, "corpus.json"), "utf8"))
    );
    const outputs = new Map([
      [
        "show-me-runtime-call-tree",
        "```text\nsubmitForm\n  createSession\n    persistPrompt\n    launchAgent\n  navigateToSession\n```",
      ],
      [
        "show-me-simple-no-visual",
        "A cache hit returns the cached result immediately.",
      ],
      [
        "show-me-focused-component-diff",
        "```diff\n <SessionPage>\n   <SessionToolbar>\n+    <RunSkillButton />\n   <SessionTimeline>\n```",
      ],
    ]);

    for (const [id, output] of outputs) {
      const checks = corpus.cases.find(
        (evalCase) => evalCase.id === id
      )?.checks;
      if (!checks) {
        throw new Error(`${id} case is missing`);
      }
      expect((await scoreOutput(output, checks)).overall).toBe(1);
    }

    const invalidOutputs = [
      [
        "show-me-runtime-call-tree",
        "```text\nsubmitForm createSession persistPrompt launchAgent navigateToSession\n```",
      ],
      [
        "show-me-simple-no-visual",
        "A cache hit returns the cached result. This avoids recomputing.",
      ],
      [
        "show-me-simple-no-visual",
        "A cache hit returns the cached result immediately.\nThis avoids recomputing.",
      ],
      [
        "show-me-simple-no-visual",
        "- A cache hit returns the cached result immediately.",
      ],
      [
        "show-me-focused-component-diff",
        "```diff\n SessionPage SessionToolbar\n+ RunSkillButton\n SessionTimeline\n```",
      ],
    ] as const;

    for (const [id, output] of invalidOutputs) {
      const checks = corpus.cases.find(
        (evalCase) => evalCase.id === id
      )?.checks;
      if (!checks) {
        throw new Error(`${id} case is missing`);
      }
      expect((await scoreOutput(output, checks)).overall).toBeLessThan(1);
    }
  });

  it("binds diagram uncertainty to the context-store branch in either order", async () => {
    const corpus = parseCorpus(
      JSON.parse(readFileSync(join(moduleDirectory, "corpus.json"), "utf8"))
    );
    const checks = corpus.cases.find(
      (evalCase) => evalCase.id === "core-clarification-diagram"
    )?.checks;
    if (!checks) {
      throw new Error("core clarification diagram case is missing");
    }

    const outputs = [
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be stale)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Stored context (may be stale)\n└→ Live tools\n```",
      "```text\nUser → LLM → MCP\n├→ Live tools\n└→ Context Store (unknown)\n```",
      "```text\nRequest -> LLM -> MCP\n|-- Context Store (might be stale)\n`-- Live tools\n```",
      "```text\nRequest\n↓\nLLM\n↓\nMCP\n├── Context Store (could be stale)\n└── Live tools\n```",
      "```text\nUser\n|\nv\nLLM\n|\nv\nMCP\n|-- Live tools\n`-- Context Store (staleness unknown)\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (possibly stale)\n└→ Live tools\n```",
      "```text\nRequest\n↓\nLLM\n↓\nMCP\n├── Context Store (potentially stale)\n└── Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Live tools\n└→ Context Store (may contain stale information)\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be outdated)\n└→ Runtime tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Runtime tools\n└→ Context Store (may be out of date)\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may not be current)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Live tools\n└→ Context Store (may contain old data)\n```",
      "```text\nRequest → LLM → MCP\n│\n├→ Context Store (may be stale)\n│\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (freshness is unknown)\n└→ Live verification tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be stale)\n└→ Runtime action tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Live action tools\n└→ Context Store (unknown freshness)\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (not guaranteed current)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Live tools\n└→ Context Store (freshness not guaranteed)\n```",
      "```text\nRequest → LLM → MCP gateway\n├→ Context Store (may be stale)\n└→ Live tools\n```",
      "```text\nRequest\n↓\nLLM\n↓\nMCP gateway\n├── Live tools\n└── Context Store (freshness is unknown)\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be stale)\n└→ Live tools (verify)\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be stale)\n└→ Runtime tools (act)\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (can be stale)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Stored context (not necessarily current)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (freshness: unknown)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Stored context (can be stale)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (not necessarily current)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Stored context (freshness: unknown)\n└→ Live tools\n```",
    ];
    for (const output of outputs) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBe(1);
    }

    const misplacedUncertainty = await scoreOutput(
      "```text\nRequest → LLM → MCP\n├→ Context Store\n└→ Live tools (unknown/stale)\n```",
      checks
    );
    expect(misplacedUncertainty.overall).toBe(0);

    const misplacedAcceptedParaphrase = await scoreOutput(
      "```text\nRequest → LLM → MCP\n├→ Context Store\n└→ Runtime tools (old data)\n```",
      checks
    );
    expect(misplacedAcceptedParaphrase.overall).toBe(0);

    const invalidDiagrams = [
      "```text\nRequest → LLM → MCP\n├→ Context Store (not stale)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Stored context (not current)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (not current)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (old data)\n└→ Runtime tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (definitely stale)\n└→ Live tools\n```",
      "```text\n├→ Context Store (may be stale)\n└→ Live tools\nRequest → LLM → MCP\n```",
      "```text\nRequest -> LLM -> MCP -> Context Store (stale) -> Live tools\n```",
      "```text\nRequest -> LLM -> MCP\n|-- Context Store (stale)\nLive tools\n```",
      "```text\nRequest\n↓\nLLM\n↓\nMCP\n├── Context Store\n└── Live tools (unknown)\n```",
      "```text\nRequest\n↓\nLLM\n↓\nMCP\nContext Store (stale)\nLive tools\n```",
      "```text\nRequest → LLM → MCP\nOther System:\n├→ Context Store (may be stale)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\nOther System:\n├→ Stored context (may be stale)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (owner unknown)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be stale but is definitely current)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be stale and remains fresh)\n└→ Runtime tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be stale)\n└→ Live production verification tools\n```",
      "```text\nRequest → LLM → MCP\nOther System:\n├→ Context Store (may be stale)\n└→ Live verification tools\n```",
      "```text\nRequest → LLM → MCP gateway\nOther System:\n├→ Context Store (may be stale)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP gateway → Router\n├→ Context Store (may be stale)\n└→ Live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be stale)\n└→ No live tools\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be stale)\n└→ Live tools unavailable\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be stale)\n└→ Live tools are disabled\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be stale)\n└→ Live tools (cannot verify or act)\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be stale)\n└→ Runtime tools (unable to verify or act)\n```",
      "```text\nRequest → LLM → MCP\n├→ Context Store (may be stale)\n└→ Live tools (not usable)\n```",
    ];
    for (const output of invalidDiagrams) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBe(0);
    }

    const passingDiagram =
      "```text\nRequest → LLM → MCP gateway\n├→ Stored context (may be stale)\n└→ Live tools\n```";
    const freshnessContradictions = [
      `The stored context is definitely current.\n${passingDiagram}`,
      `${passingDiagram}\nThe stored context is definitely current.`,
      `The stored context is guaranteed current.\n${passingDiagram}`,
      `${passingDiagram}\nThe stored context is guaranteed current.`,
      `The context store is always current.\n${passingDiagram}`,
      `${passingDiagram}\nThe context store is always current.`,
      `The stored context is guaranteed fresh.\n${passingDiagram}`,
      `${passingDiagram}\nThe context store is always fresh.`,
      `The context store remains fresh.\n${passingDiagram}`,
      `${passingDiagram}\nThe context store is certainly fresh.`,
      `${passingDiagram}\nThe stored context is up to date.`,
      `The context store remains up to date.\n${passingDiagram}`,
    ];
    for (const output of freshnessContradictions) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBe(0);
    }

    const unavailableLiveTools = [
      `Live tools are unavailable.\n${passingDiagram}`,
      `${passingDiagram}\nLive tools are unavailable.`,
      `Runtime tools are disabled.\n${passingDiagram}`,
      `${passingDiagram}\nLive tools cannot verify or act.`,
      `Runtime action tools are unable to act and verify.\n${passingDiagram}`,
    ];
    for (const output of unavailableLiveTools) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBe(0);
    }

    const unrelatedFreshness = [
      `${passingDiagram}\nThe current request still needs live verification.`,
      `Fresh live-tool results can verify the answer.\n${passingDiagram}`,
      `No live tools would make verification impossible.\n${passingDiagram}`,
      `If live tools are unavailable, verification would be impossible.\n${passingDiagram}`,
      `${passingDiagram}\nWhether runtime tools are disabled depends on deployment.`,
      `${passingDiagram}\nKeep the current docs up to date.`,
    ];
    for (const output of unrelatedFreshness) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBe(1);
    }
  });

  it("rejects write authorization and requires denial of file modification", async () => {
    const corpus = parseCorpus(
      JSON.parse(readFileSync(join(moduleDirectory, "corpus.json"), "utf8"))
    );
    const checks = corpus.cases.find(
      (evalCase) => evalCase.id === "core-simple-clarification"
    )?.checks;
    if (!checks) {
      throw new Error("core simple clarification case is missing");
    }

    const counterexample = await scoreOutput(
      "Tools may inspect and write files, but may not change permissions.",
      checks
    );
    expect(counterexample.overall).toBeLessThan(1);
    expect(
      counterexample.checks.slice(0, 2).map((check) => check.passed)
    ).toEqual([false, false]);

    const ownershipOnlyDenial = await scoreOutput(
      "Tools may inspect files but cannot change ownership of files.",
      checks
    );
    expect(ownershipOnlyDenial.overall).toBeLessThan(1);
    expect(
      ownershipOnlyDenial.checks.slice(0, 2).map((check) => check.passed)
    ).toEqual([true, false]);

    const negatedProhibitions = [
      "Tools may inspect files but does not prevent them from modifying files.",
      "Tools may inspect files but does not prohibit modifying files.",
      "Tools may inspect files but does not prohibit modification of files.",
    ];
    for (const output of negatedProhibitions) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBeLessThan(1);
      expect(result.checks[1]?.passed).toBe(false);
    }

    const negatedDenialClaims = [
      "Read-only access lets tools inspect files, but it does not mean they cannot modify them.",
      "Read-only access lets tools inspect files, but it doesn't mean they cannot modify them.",
      "Read-only access lets tools inspect files, but it doesn’t mean they cannot modify them.",
      "Read-only access lets tools inspect files, but it is not true that they cannot modify them.",
      "Tools may inspect files, but that does not mean changes cannot be saved.",
      "Tools can inspect files, but it doesn't mean they can't make changes.",
    ];
    for (const output of negatedDenialClaims) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBeLessThan(1);
      expect(result.checks[1]?.passed).toBe(false);
    }

    const authorizedWrite = await scoreOutput(
      "Tools may inspect and write files, but may not modify them.",
      checks
    );
    expect(authorizedWrite.overall).toBeLessThan(1);
    expect(
      authorizedWrite.checks.slice(0, 2).map((check) => check.passed)
    ).toEqual([false, true]);

    const equivalentWriteGrants = [
      "Tools may inspect files but may not modify them; they may overwrite files.",
      "Tools may inspect files but may not modify them; overwriting files is allowed.",
      "Tools may inspect files but may not modify them; they may replace the contents of files.",
      "Tools may inspect files but may not modify them; writing is allowed.",
      "Tools may inspect files but may not modify them; editing files is allowed.",
      "Tools may inspect files but may not modify them; they are allowed to write files.",
      "Tools may inspect files but may not modify them; writing files remains allowed.",
      "Read-only access permits tools to inspect files and prohibits file modification; writing files remains allowed.",
      "Tools may inspect files but may not modify them; they are permitted to write files.",
      "Tools may inspect files but may not modify them; they are authorized to write files.",
      "Tools may inspect files but may not modify them; go ahead and write files.",
      "Tools may inspect files but may not modify them; feel free to edit files.",
      "Tools may inspect files but may not modify them; modifications are permitted.",
      "Tools may inspect files but may not modify them; writes are authorized.",
      "Tools may inspect files but may not modify them; they can change files.",
      "Tools may inspect files but may not modify them; however, they can alter files.",
      "Tools may inspect files but may not modify them; altering files is allowed.",
      "Tools may inspect files but may not modify them; they are authorized to alter files.",
      "Tools may inspect files but may not modify them; they have permission to write files.",
      "Tools may inspect files but may not modify them; write access is enabled.",
      "Tools may inspect files but may not modify them; they have write access.",
      "Tools may inspect files but may not modify them; they have file permission to edit files.",
      "Tools may inspect files but may not modify them; file write access is granted.",
      "Tools may inspect files but may not modify them; write access remains enabled.",
      "Tools may inspect files but may not modify them; write access stays enabled.",
      "Tools may inspect files but may not modify them; write access remains available.",
      "Tools can inspect files but cannot modify them; write access still exists.",
      "Tools may inspect files but may not modify them; edit access exists.",
      "Tools may inspect files but may not modify them; change capability continues to exist.",
      "Tools may inspect files but may not modify them; file write capability remains present.",
      "Tools may inspect files but may not modify them; file edit access continues to be granted.",
      "Tools may inspect files but may not modify them; writing files is possible.",
      "Tools may inspect files but may not modify them; they are able to write files.",
      "Tools may inspect files but may not modify them; writing files is possible unless necessary.",
      "Tools may inspect files but may not modify them; write files when necessary.",
      "Tools may inspect files but may not modify them; edit files if necessary.",
      "Tools may inspect files but may not modify them; tools write files when necessary.",
      "Tools may inspect files but may not modify them; write files only if necessary.",
      "Tools may inspect files but may not modify them; tools retain editing rights.",
      "Tools may inspect files but may not modify them; tools retain write privileges.",
      "Tools may inspect files but may not modify them; tools have change rights.",
      "Tools may inspect files but may not modify them; tools keep modification privileges.",
      "Tools may inspect files but may not modify them; tools retain update rights.",
      "Tools can inspect files but can't make changes; however, they can write files.",
      "Tools may inspect files but cannot modify them; deletion is allowed.",
      "Tools may inspect files but cannot modify them; they can delete files.",
      "Tools may inspect files but cannot modify them; removal is permitted.",
      "Tools may inspect files but cannot modify them; they are authorized to rename files.",
      "Tools may inspect files but cannot modify them; go ahead and create files.",
      "Tools may inspect files but cannot modify them; tools retain creation rights.",
      "Tools may inspect files but cannot modify them; changes can still be made by the agent.",
      "Tools may inspect files but cannot modify them; the agent is free to delete them.",
      "Tools may inspect files but cannot modify them; they are free to delete them.",
      "Tools may inspect files without changing them; editing files is allowed.",
      "Tools may inspect files but changes cannot be saved; write access still exists.",
    ];
    for (const output of equivalentWriteGrants) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBeLessThan(1);
      expect(result.checks.slice(0, 2).map((check) => check.passed)).toEqual([
        false,
        true,
      ]);
    }

    const alternateSubjectDenials = [
      "Tools may inspect files, but users cannot modify them.",
      "Tools may inspect files, but developers may not modify them.",
      "Tools may inspect files, but owners cannot modify them.",
      "Tools may inspect files, but users cannot alter them.",
      "Tools may inspect files, but users may inspect files without changing them.",
      "Tools can inspect files, but users can't make changes.",
    ];
    for (const output of alternateSubjectDenials) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBeLessThan(1);
      expect(result.checks.slice(0, 2).map((check) => check.passed)).toEqual([
        true,
        false,
      ]);
    }

    const conditionalDenials = [
      "Tools may inspect files but cannot modify them unless necessary.",
      "Yes, tools may inspect files but cannot modify them, unless necessary.",
      "Read-only access lets tools inspect files, but they may not edit them except in emergencies.",
      "Tools may inspect files but are not allowed to modify them if necessary.",
      "Tools may inspect files but cannot write to them when emergencies occur.",
      "Tools may inspect files but cannot edit them only if necessary.",
      "Read-only access lets tools inspect files but prevents them from editing them unless necessary.",
      "Read-only access lets tools inspect files; editing them is prohibited except in emergencies.",
      "Read-only access lets tools inspect files but prohibits file modification except in emergencies.",
      "Tools may inspect files but have no write access unless explicitly authorized.",
      "Tools may inspect files but have no edit access except with authorization.",
      "Tools may inspect files but have no change access if approved.",
      "Tools may inspect files but have no update access when authorized.",
      "Tools may inspect files but cannot modify them without approval.",
      "Tools may inspect files but may not modify them without authorization.",
      "Tools may inspect files but aren't allowed to modify them by default.",
      "Tools may inspect files but may not edit them under normal circumstances.",
      "Tools may inspect files but are generally not permitted to update them.",
      "Tools may inspect files but lack write permission unless explicitly authorized.",
      "Tools may inspect files but have no file write permission except with authorization.",
      "Tools may inspect files but cannot alter them unless necessary.",
      "Tools can inspect files but can't make changes unless necessary.",
      "Tools may inspect files without changing them unless necessary.",
      "Read-only access lets tools inspect files without modifying them if approved.",
      "Tools may inspect files but cannot save changes unless approved.",
      "Tools may inspect files but changes cannot be persisted except with authorization.",
    ];
    for (const output of conditionalDenials) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBeLessThan(1);
      expect(result.checks[1]?.passed).toBe(false);
    }

    const explicitlyAuthorizedAnswers = [
      "Tools may inspect files but have no write access; write access is granted with authorization.",
      "Tools may inspect files but cannot alter them; they are authorized to alter files.",
    ];
    for (const output of explicitlyAuthorizedAnswers) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBeLessThan(1);
      expect(result.checks[0]?.passed).toBe(false);
    }

    const multipleSentences = [
      "Yes. Tools may inspect files but may not modify them.",
      "Yes! Tools may inspect files but may not modify them.",
      "Tools may inspect files but may not modify them. 100% read-only.",
      "Yes.Tools may inspect files but may not modify them.",
    ];
    for (const output of multipleSentences) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBeLessThan(1);
      expect(result.checks[2]?.passed).toBe(false);
    }

    const advisoryDenials = [
      "Tools may inspect files but should not modify them.",
      "Tools may inspect files but shouldn't edit them.",
      "Tools may inspect files but shouldn’t write to them.",
      "Tools may inspect files but should not change them.",
      "Tools may inspect files but should not update them.",
      "Tools may inspect files but should not delete them.",
      "Tools may inspect files but should not create them.",
      "Tools may inspect files but should not rename them.",
      "Tools may inspect files but should not alter them.",
      "Tools may inspect files but should not save changes.",
      "Tools can inspect files but should not make changes.",
    ];
    for (const output of advisoryDenials) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBeLessThan(1);
      expect(result.checks[1]?.passed).toBe(false);
    }

    const propositionNegations = [
      "No, tools may inspect files but may not modify them.",
      "No—tools may inspect files but may not modify them.",
      "It is false that tools may inspect files but may not modify them.",
      "It isn't true that tools may inspect files but may not modify them.",
      "That is false: tools may inspect files but may not modify them.",
      "False, tools may inspect files but may not modify them.",
    ];
    for (const output of propositionNegations) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBe(0);
    }

    const validAnswers = [
      "Tools may inspect files but may not modify them.",
      "Yes, tools may inspect files but may not modify them.",
      "Files can be read but not written.",
      "Files can be inspected but cannot be written.",
      "Files may be viewed but may not be modified.",
      "Files are readable but not writable.",
      "Tools may inspect files but cannot overwrite them.",
      "Tools may inspect files but cannot modify them.",
      "Tools may inspect files but can't modify them.",
      "Tools may inspect files but can’t modify them.",
      "Tools may inspect files but can't write to them.",
      "Tools may inspect files but can't edit them.",
      "Yes, tools can inspect files but cannot make changes to them.",
      "Tools may inspect files but may not make changes to files.",
      "Tools may inspect files but cannot make modifications to them.",
      "Tools can view files but can't make any changes to them.",
      "Tools may inspect files but may not make any modifications to them.",
      "Tools may inspect files without changing them.",
      "Tools can read files without editing them.",
      "Read-only access lets tools inspect files without modifying them.",
      "Read-only access permits tools to view files without altering them.",
      "Yes, tools can view files, but they cannot change them.",
      "Tools are allowed to view files but may not modify them.",
      "Tools have viewing access but cannot edit files.",
      "Tools may inspect files but cannot alter them.",
      "Read-only access permits tools to inspect files and prohibits alterations to files.",
      "The tools may inspect files, but read-only access does not allow them to modify files.",
      "Read-only access lets tools inspect files, but they do not have permission to modify them.",
      "Read-only access lets tools inspect files, but they cannot change them.",
      "Tools can inspect files, but they do not have permission to modify them.",
      "Tools may inspect files but are not allowed to modify them.",
      "Tools may inspect files but aren't allowed to modify them.",
      "Tools may inspect files but aren’t allowed to modify them.",
      "The agent may inspect files but isn't permitted to edit them.",
      "The agent may inspect files but isn’t permitted to edit them.",
      "Tools may inspect files but are not permitted to edit them.",
      "Tools may inspect files but are not authorized to change them.",
      "Tools may inspect files but are not allowed to update them.",
      "Tools may inspect files but are not permitted to write to them.",
      "Yes—read-only access allows tools to inspect files, not modify them.",
      "Read-only access permits tools to inspect files and prohibits modifying them.",
      "Read-only access can permit tools to inspect files and prohibit modifying them.",
      "Read-only access permits tools to inspect files and prohibits file modification.",
      "Read-only access permits tools to inspect files and prohibits modification of files.",
      "Tools may inspect files, but file modification is prohibited.",
      "Read-only access permits tools to inspect files and prohibits modifications to files.",
      "Read-only rules permit tools to inspect files but forbid editing them.",
      "Read-only access permits tools to inspect files but forbids writing to them.",
      "Yes—read-only access allows tools to inspect files but prevents them from modifying files.",
      "Read-only access allows tools to inspect files but prevents tools from writing to files.",
      "Read-only access lets tools inspect files but prevents them from editing them.",
      "Read-only access permits tools to inspect files but prevents them from changing files.",
      "Read-only access allows tools to inspect files but prevents tools from updating them.",
      "Read-only access permits tools to inspect files; modifying them is not allowed",
      "Read-only access permits tools to inspect files; editing them is disallowed",
      "Read-only access permits tools to inspect files; writing to them is prohibited",
      "Tools have permission to inspect files but lack permission to modify them.",
      "Tools may inspect files but have no write access.",
      "Tools can inspect files, but they lack write permission.",
      "Tools may inspect files but lack file write permission.",
      "Tools may inspect files but have no write permission.",
      "Tools may inspect files but have no file write permission.",
      "Tools may inspect files but no write access exists.",
      "Tools may inspect files but write access does not exist.",
      "Tools may inspect files but file edit capability no longer exists.",
      "Read-only access lets tools inspect files, with no edit access.",
      "Tools can inspect files but have no change access.",
      "Tools may inspect files but lack modify access.",
      "Tools are allowed to inspect files but may not modify them.",
      "Tools are permitted to read files but have no write access.",
      "The agent is authorized to inspect files but cannot modify them.",
      "Tools have read access but no write access.",
      "Tools have inspection access but cannot edit files.",
      "Tools may inspect files but may not modify them—read-only access.",
      "Yes, tools can inspect files, but any changes cannot be saved.",
      "Tools may inspect files but cannot save changes to files.",
      "Yes, tools can inspect files without making changes.",
      "Yes, tools can inspect files, but they can't make changes.",
      "The agent may inspect files but is unable to persist file modifications.",
      "Tools may inspect files but file changes cannot be persisted.",
      "Read-only access lets tools inspect files, but modifications to files may not be saved.",
    ];
    for (const output of validAnswers) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBe(1);
    }

    const passiveCounterexamples = [
      "Files cannot be read but not written.",
      "Files can be written.",
      "Files can be read but not written unless approved.",
      "Files are readable but not writable if locked.",
      "Files can be read but not written; tools may overwrite files.",
    ];
    for (const output of passiveCounterexamples) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBeLessThan(1);
    }

    const negatedInspectionGrants = [
      "Read-only access does not allow tools to inspect files, but tools may not modify them.",
      "Read-only access doesn't allow tools to inspect files, but tools may not modify them.",
      "Read-only access doesn’t allow tools to inspect files, but tools may not modify them.",
      "Tools do not have permission to inspect files, but may not modify them.",
      "Tools don't have permission to inspect files, but may not modify them.",
      "Tools don’t have permission to inspect files, but may not modify them.",
      "Tools are not allowed to inspect files but may not modify them.",
      "Tools cannot view files and may not modify them.",
      "Read-only access does not allow tools to view files, but tools may not modify them.",
      "Tools have no read access and may not modify files.",
    ];
    for (const output of negatedInspectionGrants) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBeLessThan(1);
      expect(result.checks[0]?.passed).toBe(false);
    }

    const negatedNominalProhibitions = [
      "Tools may inspect files, but file modification is not prohibited.",
      "Read-only access permits tools to inspect files, but modifications to files are not forbidden.",
      "Tools may inspect files, but file modification is prohibited unless approved.",
    ];
    for (const output of negatedNominalProhibitions) {
      const result = await scoreOutput(output, checks);
      expect(result.overall).toBeLessThan(1);
      expect(result.checks[1]?.passed).toBe(false);
    }
  });

  it("has exactly seven diagnose cases with deterministic safety checks", () => {
    const corpus = parseCorpus(
      JSON.parse(readFileSync(join(moduleDirectory, "corpus.json"), "utf8"))
    );
    const diagnoseCases = corpus.cases.filter(
      (evalCase) => evalCase.promptPath === "skills/diagnose/SKILL.md"
    );

    expect(diagnoseCases.map((evalCase) => evalCase.id)).toEqual([
      "diagnose-exact-anchor",
      "diagnose-feedback-loop-required",
      "diagnose-incomplete-no-fix",
      "diagnose-flaky-loop-plan",
      "diagnose-proven-gate-approved",
      "diagnose-private-probe-design",
      "diagnose-fix-it-stop",
    ]);
    expect(
      diagnoseCases.every((evalCase) =>
        evalCase.checks.some(
          (check) => check.domain === "task" || check.domain === "tests"
        )
      )
    ).toBe(true);

    const caseById = new Map(
      diagnoseCases.map((evalCase) => [evalCase.id, evalCase])
    );
    const gateCaseIds = [
      "diagnose-proven-gate-approved",
      "diagnose-fix-it-stop",
    ];
    for (const id of gateCaseIds) {
      const evalCase = caseById.get(id);
      expect(evalCase?.tools).toContain("questionnaire");
      expect(evalCase?.checks).toContainEqual(
        expect.objectContaining({
          type: "questionnaireGate",
          domain: "task",
        })
      );
    }
    const approvedCase = caseById.get("diagnose-proven-gate-approved");
    expect(approvedCase?.questionnaireResponse).toBe("Approve scoped fix");
    expect(approvedCase?.checks).toContainEqual(
      expect.objectContaining({
        type: "toolCalledAfter",
        name: "edit",
        after: "questionnaire",
        domain: "tests",
      })
    );
    expect(approvedCase?.checks).toContainEqual(
      expect.objectContaining({
        type: "toolCalledAfter",
        name: "bash",
        after: "edit",
        args: { command: "bun test tests/math.case.ts" },
        domain: "tests",
      })
    );
    expect(approvedCase?.checks).toContainEqual(
      expect.objectContaining({
        type: "workspaceChangesOnly",
        paths: ["src/math.ts"],
        domain: "tests",
      })
    );
    expect(caseById.get("diagnose-exact-anchor")?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "outputIncludes",
          value: "Diagnosis: Incomplete",
          domain: "task",
        }),
        expect.objectContaining({
          type: "outputIncludes",
          value: "Fix: Not attempted",
          domain: "task",
        }),
        expect.objectContaining({
          type: "toolNotCalled",
          name: "questionnaire",
          domain: "tests",
        }),
        expect.objectContaining({
          type: "outputMatches",
          domain: "tests",
        }),
      ])
    );
    expect(caseById.get("diagnose-exact-anchor")?.checks).toContainEqual(
      expect.objectContaining({
        type: "outputIncludes",
        value: "bun test tests/math.case.ts",
        domain: "evidence",
      })
    );
    expect(caseById.get("diagnose-exact-anchor")?.checks).toContainEqual(
      expect.objectContaining({
        type: "toolCallMatchesBeforeAssistantMatches",
        name: "bash",
        args: { command: "bun test tests/math.case.ts" },
        isError: true,
        assistantPattern: expect.stringContaining("root cause"),
        domain: "task",
      })
    );
    expect(caseById.get("diagnose-feedback-loop-required")?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "outputMatches",
          pattern: "red-capable|feedback loop",
          domain: "quality",
        }),
        expect.objectContaining({
          type: "outputMatches",
          pattern: expect.stringContaining("root cause"),
          domain: "tests",
        }),
        expect.objectContaining({
          type: "workspaceUnchanged",
          domain: "tests",
        }),
      ])
    );
    expect(caseById.get("diagnose-flaky-loop-plan")?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "outputMatches",
          pattern: "repeat|parallel|stress|timing",
          domain: "quality",
        }),
        expect.objectContaining({
          type: "outputMatches",
          domain: "evidence",
        }),
        expect.objectContaining({
          type: "outputMatches",
          pattern: expect.stringContaining("discovery|amplif"),
          domain: "tests",
        }),
      ])
    );

    const feedbackCausalCheck = caseById
      .get("diagnose-feedback-loop-required")
      ?.checks.find(
        (check) =>
          check.type === "outputMatches" && check.pattern.includes("root cause")
      );
    expect(feedbackCausalCheck?.type).toBe("outputMatches");
    if (feedbackCausalCheck?.type === "outputMatches") {
      const pattern = new RegExp(
        feedbackCausalCheck.pattern,
        feedbackCausalCheck.flags
      );
      const rejectedCausalClaims = [
        "Diagnosis: Incomplete\nFix: Not attempted\nThe root cause is subtraction.",
        "Diagnosis: Incomplete\nFix: Not attempted\nsrc/math.ts implements add with left - right, which explains the reported 2.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe reported 2 comes from left - right in src/math.ts.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe leading explanation is subtraction.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe most likely cause is the subtraction operator.",
        "Diagnosis: Incomplete\nFix: Not attempted\nC1 | add uses subtraction | predicts 2",
        "Diagnosis: Incomplete\nFix: Not attempted\nSubtraction caused the bug.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe culprit is the subtraction operator.",
        "Diagnosis: Incomplete\nFix: Not attempted\nSubtraction means add returns 2.",
        "Diagnosis: Incomplete\nFix: Not attempted\nSubtraction therefore makes add return 2.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe implementation makes add return 2.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe implementation causes add to return 2.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe implementation yields the observed 2.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe implementation is responsible for the observed 2.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe subtraction operator explains why add returns 2.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe function returns 2 because it subtracts right from left.",
        "Diagnosis: Incomplete\nFix: Not attempted\nWe can inspect src/math.ts to distinguish the cause.",
      ];
      for (const output of rejectedCausalClaims) {
        expect(pattern.test(output)).toBe(false);
      }

      const allowedLoopPlanning = [
        "Diagnosis: Incomplete\nFix: Not attempted\nsrc/math.ts implements add with left - right. This source observation is not a causal conclusion; run bun test tests/math.case.ts to establish the feedback loop.",
        "Diagnosis: Incomplete\nFix: Not attempted\nSubtraction does not explain the result.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe root cause is not yet known.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe implementation does not make add return 2.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe implementation is not responsible for the observed 2.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe subtraction operator does not explain why add returns 2.",
        "Diagnosis: Incomplete\nFix: Not attempted\nThe function returns 2 because it does not subtract right from left.",
        "Diagnosis: Incomplete\nFix: Not attempted\nWe can inspect src/math.ts after reproduction.",
      ];
      for (const output of allowedLoopPlanning) {
        expect(pattern.test(output)).toBe(true);
      }
    }

    const flakySeparationCheck = caseById
      .get("diagnose-flaky-loop-plan")
      ?.checks.find(
        (check) =>
          check.type === "outputMatches" &&
          check.pattern.includes("discovery|amplif")
      );
    expect(flakySeparationCheck?.type).toBe("outputMatches");
    if (flakySeparationCheck?.type === "outputMatches") {
      const pattern = new RegExp(
        flakySeparationCheck.pattern,
        flakySeparationCheck.flags
      );
      expect(
        pattern.test(
          "Amplify discovery with parallel stress, but that is not proof; return to fixed conditions."
        )
      ).toBe(true);
      expect(pattern.test("Use parallel stress for proof.")).toBe(false);
    }

    const stopCase = caseById.get("diagnose-fix-it-stop");
    expect(stopCase?.questionnaireResponse).toBe("Stop and clean probes");
    expect(stopCase?.checks).toContainEqual(
      expect.objectContaining({ type: "workspaceUnchanged", domain: "tests" })
    );
    for (const evalCase of diagnoseCases.filter(
      (candidate) => candidate.questionnaireResponse !== "Approve scoped fix"
    )) {
      expect(evalCase.checks).toContainEqual(
        expect.objectContaining({
          type: "workspaceUnchanged",
          domain: "tests",
        })
      );
    }

    expect(
      caseById
        .get("diagnose-incomplete-no-fix")
        ?.checks.some(
          (check) => check.type === "outputMatches" && check.domain === "tests"
        )
    ).toBe(true);
    expect(
      caseById
        .get("diagnose-private-probe-design")
        ?.checks.some(
          (check) =>
            check.type === "outputMatches" &&
            check.domain === "tests" &&
            check.pattern.includes("DIAG_FAKE_TOKEN_7f3a91_RAW")
        )
    ).toBe(true);
  });

  it("fails the exact complete no-loop result-first causal report", async () => {
    const corpus = parseCorpus(
      JSON.parse(readFileSync(join(moduleDirectory, "corpus.json"), "utf8"))
    );
    const checks = corpus.cases.find(
      (evalCase) => evalCase.id === "diagnose-feedback-loop-required"
    )?.checks;
    if (!checks) {
      throw new Error("diagnose feedback-loop case is missing");
    }

    const conformingReport =
      "Diagnosis: Incomplete\nFix: Not attempted\nA red-capable feedback loop requires bun test tests/math.case.ts.";
    const workspace = createTemporaryDirectory();
    const initialWorkspaceSnapshot = await snapshotWorkspace(workspace);
    const validResult = await scoreRun(
      {
        output: conformingReport,
        workspace,
        initialWorkspaceSnapshot,
        toolCalls: [],
      },
      checks
    );
    expect(validResult.overall).toBe(1);

    const result = await scoreRun(
      {
        output: `${conformingReport} The function returns 2 because it subtracts right from left.`,
        workspace,
        initialWorkspaceSnapshot,
        toolCalls: [],
      },
      checks
    );

    expect(result.overall).toBeLessThan(1);
    expect(
      result.checks.find(
        ({ check }) =>
          check.type === "outputMatches" && check.pattern.includes("root cause")
      )?.passed
    ).toBe(false);
  });
});

describe("changedPromptPaths", () => {
  it("discovers only supported prompt changes", async () => {
    const repository = createTemporaryDirectory();
    run(repository, "git", ["init"]);
    run(repository, "git", ["config", "user.email", "eval@example.com"]);
    run(repository, "git", ["config", "user.name", "Eval Test"]);
    const paths = [
      "agents/explorer.md",
      "extensions/core-prompt/prompt.md",
      "skills/diagnose/SKILL.md",
      "skills/showing-me/SKILL.md",
      "skills/other/SKILL.md",
    ];
    for (const path of paths) {
      mkdirSync(join(repository, path, ".."), { recursive: true });
      writeFileSync(join(repository, path), "baseline\n");
    }
    run(repository, "git", ["add", "."]);
    run(repository, "git", ["commit", "-m", "baseline"]);
    for (const path of paths) {
      writeFileSync(join(repository, path), "candidate\n");
    }

    expect(await changedPromptPaths(repository)).toEqual([
      "agents/explorer.md",
      "extensions/core-prompt/prompt.md",
      "skills/diagnose/SKILL.md",
      "skills/showing-me/SKILL.md",
    ]);
  });

  it("discovers a newly added supported prompt", async () => {
    const repository = createTemporaryDirectory();
    run(repository, "git", ["init"]);
    run(repository, "git", ["config", "user.email", "eval@example.com"]);
    run(repository, "git", ["config", "user.name", "Eval Test"]);
    writeFileSync(join(repository, "README.md"), "fixture\n");
    run(repository, "git", ["add", "README.md"]);
    run(repository, "git", ["commit", "-m", "baseline"]);
    mkdirSync(join(repository, "skills/showing-me"), { recursive: true });
    writeFileSync(
      join(repository, "skills/showing-me/SKILL.md"),
      "candidate\n"
    );

    expect(await changedPromptPaths(repository)).toEqual([
      "skills/showing-me/SKILL.md",
    ]);
  });
});

describe("snapshotPromptCandidates", () => {
  it("tracks untracked path lists, existence, and content", async () => {
    const repository = createTemporaryDirectory();
    const promptPath = "skills/showing-me/SKILL.md";
    mkdirSync(join(repository, "skills/showing-me"), { recursive: true });
    writeFileSync(join(repository, promptPath), "candidate\n");

    const initial = await snapshotPromptCandidates(repository, [promptPath]);
    writeFileSync(join(repository, promptPath), "changed\n");
    expect(await snapshotPromptCandidates(repository, [promptPath])).not.toBe(
      initial
    );

    rmSync(join(repository, promptPath));
    expect(await snapshotPromptCandidates(repository, [promptPath])).not.toBe(
      initial
    );

    writeFileSync(join(repository, promptPath), "candidate\n");
    expect(
      await snapshotPromptCandidates(repository, [
        promptPath,
        "skills/missing/SKILL.md",
      ])
    ).not.toBe(initial);
  });
});

describe("loadPromptPair", () => {
  it("uses an empty baseline for a newly added prompt", async () => {
    const repository = createTemporaryDirectory();
    run(repository, "git", ["init"]);
    run(repository, "git", ["config", "user.email", "eval@example.com"]);
    run(repository, "git", ["config", "user.name", "Eval Test"]);
    writeFileSync(join(repository, "README.md"), "fixture\n");
    run(repository, "git", ["add", "README.md"]);
    run(repository, "git", ["commit", "-m", "baseline"]);
    mkdirSync(join(repository, "skills/showing-me"), { recursive: true });
    writeFileSync(
      join(repository, "skills/showing-me/SKILL.md"),
      "---\nname: showing-me\n---\n\n# Show Me\n"
    );

    const pair = await loadPromptPair(repository, "skills/showing-me/SKILL.md");

    expect(pair.baseline.content).toBe("");
    expect(pair.candidate.content).toContain("# Show Me");
  });

  it("rejects baseline blob failures when the tree path exists", async () => {
    const repository = createTemporaryDirectory();
    run(repository, "git", ["init"]);
    run(repository, "git", ["config", "user.email", "eval@example.com"]);
    run(repository, "git", ["config", "user.name", "Eval Test"]);
    writeFileSync(join(repository, "prompt.md"), "baseline\n");
    run(repository, "git", ["add", "prompt.md"]);
    run(repository, "git", ["commit", "-m", "baseline"]);
    const blob = spawnSync("git", ["rev-parse", "HEAD:prompt.md"], {
      cwd: repository,
    })
      .stdout.toString()
      .trim();
    rmSync(
      join(repository, ".git", "objects", blob.slice(0, 2), blob.slice(2))
    );

    await expect(loadPromptPair(repository, "prompt.md")).rejects.toThrow(
      "cannot read HEAD:prompt.md"
    );
  });

  it("reads exact HEAD and working-tree prompt bytes without moving HEAD", async () => {
    const repository = createTemporaryDirectory();
    run(repository, "git", ["init"]);
    run(repository, "git", ["config", "user.email", "eval@example.com"]);
    run(repository, "git", ["config", "user.name", "Eval Test"]);
    writeFileSync(join(repository, "prompt.md"), "baseline\n");
    run(repository, "git", ["add", "prompt.md"]);
    run(repository, "git", ["commit", "-m", "baseline"]);
    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
    }).stdout.toString();
    writeFileSync(join(repository, "prompt.md"), "candidate");

    const pair = await loadPromptPair(repository, "prompt.md");

    expect(pair.baseline.content).toBe("baseline\n");
    expect(pair.candidate.content).toBe("candidate");
    expect(pair.baseline.sha256).not.toBe(pair.candidate.sha256);
    expect(
      spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
      }).stdout.toString()
    ).toBe(headBefore);
    expect(readFileSync(join(repository, "prompt.md"), "utf8")).toBe(
      "candidate"
    );
  });

  it("rejects a candidate prompt symlink before reading external content", async () => {
    const repository = createTemporaryDirectory();
    const external = createTemporaryDirectory();
    run(repository, "git", ["init"]);
    run(repository, "git", ["config", "user.email", "eval@example.com"]);
    run(repository, "git", ["config", "user.name", "Eval Test"]);
    writeFileSync(join(repository, "prompt.md"), "baseline\n");
    run(repository, "git", ["add", "prompt.md"]);
    run(repository, "git", ["commit", "-m", "baseline"]);
    writeFileSync(join(external, "secret.txt"), "do not send\n");
    rmSync(join(repository, "prompt.md"));
    symlinkSync(join(external, "secret.txt"), join(repository, "prompt.md"));

    await expect(loadPromptPair(repository, "prompt.md")).rejects.toThrow(
      "regular non-symlink file"
    );
  });
});

describe("composePrompt", () => {
  it("appends core prompt content to a pinned production-like base", () => {
    const prompt = composePrompt(
      "extensions/core-prompt/prompt.md",
      "<identity>core</identity>"
    );

    expect(prompt).toStartWith(CORE_EVAL_BASE_PROMPT);
    expect(prompt).toEndWith("<identity>core</identity>");
  });

  it("strips agent frontmatter while retaining the role body", () => {
    const prompt = composePrompt(
      "agents/explorer.md",
      "---\ndescription: Explore\nthinking: low\n---\n\n# Explorer\nRead only."
    );

    expect(prompt).toContain("You are a SupaPi subagent.");
    expect(prompt).toContain("# Explorer\nRead only.");
    expect(prompt).not.toContain("description: Explore");
  });

  it("strips diagnose skill frontmatter while retaining its body", () => {
    const prompt = composePrompt(
      "skills/diagnose/SKILL.md",
      "---\nname: diagnose\ndescription: Diagnose failures\n---\n\n# Diagnose\nReproduce first."
    );

    expect(prompt).toContain("# Diagnose\nReproduce first.");
    expect(prompt).not.toContain("name: diagnose");
  });
});

describe("run metrics", () => {
  it("collects usage, turns, tool calls, failures, and recovery", () => {
    let metrics = createEmptyMetrics();
    metrics = reduceRunEvent(metrics, {
      type: "message_end",
      message: {
        role: "assistant",
        model: "gpt-5.6-sol",
        usage: {
          input: 100,
          output: 30,
          reasoning: 12,
          cacheRead: 40,
          cacheWrite: 10,
          totalTokens: 180,
          cost: { total: 0.02 },
        },
        content: [],
        stopReason: "toolUse",
      },
    });
    metrics = reduceRunEvent(metrics, {
      type: "tool_execution_end",
      toolName: "read",
      args: { path: "src/math.ts" },
      isError: true,
    });
    metrics = reduceRunEvent(metrics, {
      type: "tool_execution_end",
      toolName: "read",
      args: { path: "src/math.ts" },
      isError: false,
    });

    expect(metrics).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 12,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      costUsd: 0.02,
      turns: 1,
      toolCalls: 2,
      toolErrors: 1,
      recoveredToolErrors: 1,
    });
  });
});

describe("scoreRun and aggregateVariants", () => {
  it("scores output and immutable file checks deterministically", async () => {
    const workspace = createTemporaryDirectory();
    writeFileSync(join(workspace, "artifact.txt"), "safe value\n");

    const result = await scoreRun(
      { output: "Result 42", workspace, toolCalls: [] },
      [
        {
          type: "outputMatches",
          pattern: "Result \\d+",
          domain: "quality",
          weight: 1,
        },
        {
          type: "fileContains",
          path: "artifact.txt",
          value: "safe",
          domain: "task",
          weight: 1,
        },
        {
          type: "fileNotContains",
          path: "artifact.txt",
          value: "unsafe",
          domain: "task",
          weight: 1,
        },
        {
          type: "fileContains",
          path: "artifact.txt",
          value: "value",
          domain: "tests",
          weight: 1,
        },
      ]
    );

    expect(result.overall).toBe(1);
    expect(result.domains).toEqual({
      evidence: null,
      quality: 1,
      task: 1,
      tests: 1,
    });
  });

  it("binds reproduction evidence to the exact bash call and expected red result", async () => {
    const check = {
      type: "toolCallMatches" as const,
      name: "bash",
      args: { command: "bun test tests/math.case.ts" },
      resultPattern: "0 pass\\s+1 fail\\s+Expected add\\(7, 5\\) to be 12",
      flags: "i",
      isError: true,
      domain: "task" as const,
      weight: 1,
    };
    const output =
      "Ran bun test tests/math.case.ts: 0 pass, 1 fail; add returned 2.";
    const expectedRedCall = {
      name: "bash",
      args: { command: "bun test tests/math.case.ts" },
      assistantTurn: 1,
      isError: true,
      resultText: "0 pass\n1 fail\nExpected add(7, 5) to be 12\n",
    };

    const passing = await scoreRun(
      {
        output,
        workspace: createTemporaryDirectory(),
        toolCalls: [expectedRedCall],
      },
      [check]
    );
    expect(passing.overall).toBe(1);

    const passingWithTimeout = await scoreRun(
      {
        output,
        workspace: createTemporaryDirectory(),
        toolCalls: [
          {
            ...expectedRedCall,
            args: {
              command: "bun test tests/math.case.ts",
              timeout: 30,
            },
          },
        ],
      },
      [check]
    );
    expect(passingWithTimeout.overall).toBe(1);

    const invalidCalls = [
      {
        ...expectedRedCall,
        args: { command: "echo unrelated" },
      },
      {
        ...expectedRedCall,
        resultText: "Blocked by eval command allowlist: echo unrelated",
      },
      {
        ...expectedRedCall,
        resultText: "Command failed before tests ran",
      },
    ];
    for (const invalidCall of invalidCalls) {
      const result = await scoreRun(
        {
          output,
          workspace: createTemporaryDirectory(),
          toolCalls: [invalidCall],
        },
        [check]
      );
      expect(result.overall).toBe(0);
    }
  });

  it("limits reproduction ordering to affirmative reasoning and concrete probes", async () => {
    const corpus = parseCorpus(
      JSON.parse(readFileSync(join(moduleDirectory, "corpus.json"), "utf8"))
    );
    const check = corpus.cases
      .find((evalCase) => evalCase.id === "diagnose-exact-anchor")
      ?.checks.find(
        (candidate) =>
          candidate.type === "toolCallMatchesBeforeAssistantMatches"
      );
    if (!check) {
      throw new Error("diagnose reproduction-order check is missing");
    }
    const toolCalls = [
      {
        name: "bash",
        args: { command: "bun test tests/math.case.ts", timeout: 30 },
        assistantTurn: 2,
        isError: true,
        resultText: "0 pass\n1 fail\nExpected add(7, 5) to be 12\n",
      },
    ];

    for (const text of [
      "Run this because it asserts the exact symptom.",
      "I will not design probes or rank a candidate before reproduction.",
      "Do not probe src/math.ts before reproduction.",
      "Probe src/math.ts only after reproduction.",
      "I will inspect src/math.ts after reproduction.",
      "We should trace src/math.ts until the reproduction.",
      "Let's instrument src/math.ts after reproduction.",
      "Subtraction does not make add return 2.",
      "Subtraction is not why add returns 2.",
      "Subtraction does not explain the result.",
      "Subtraction cannot cause the bug.",
      "Subtraction does not necessarily explain the result.",
      "The root cause is not yet known.",
      "The root cause isn't known.",
      "The root cause seems unknown.",
      "The root cause is currently unknown.",
      "Root cause: unknown.",
      "Root cause: not subtraction.",
      "Likely cause: unknown.",
      "Likely cause: not subtraction.",
      "No hypothesis is warranted before reproduction.",
      "The hypothesis is not warranted before reproduction.",
      "The hypothesis isn't warranted before reproduction.",
      "The hypothesis is currently unknown.",
      "Hypothesis: unknown.",
      "We can inspect src/math.ts to distinguish the cause after reproduction.",
      "We could probe src/math.ts until the reproduction.",
    ]) {
      const result = await scoreRun(
        {
          output: "Diagnosis: Incomplete",
          workspace: createTemporaryDirectory(),
          toolCalls,
          assistantMessages: [{ text, assistantTurn: 1 }],
        },
        [check]
      );
      expect(result.overall).toBe(1);
    }

    for (const text of [
      "The root cause is subtraction.",
      "Root cause: subtraction.",
      "Likely cause: subtraction.",
      "Cause: subtraction.",
      "Subtraction is the root cause.",
      "Subtraction caused the bug.",
      "The culprit is the subtraction operator.",
      "Subtraction means add returns 2.",
      "Subtraction therefore makes add return 2.",
      "Hypothesis: subtraction is responsible.",
      "I will inspect src/math.ts to discriminate the cause.",
      "We can inspect src/math.ts to distinguish the cause.",
      "Subtraction explains the result.",
      "add returns 2 due to subtraction.",
      "subtraction is responsible for the observed 2.",
      "the defect stems from subtraction.",
      "Subtraction makes add return 2.",
      "add returns 2 since it subtracts.",
      "add returns 2 because the implementation subtracts.",
      "the implementation subtracts, so add returns 2.",
      "the implementation subtracts; therefore add returns 2.",
      "the subtraction operator is why add returns 2.",
      "Subtraction yields the observed 2.",
      "The implementation makes add return 2.",
      "The implementation causes add to return 2.",
      "The implementation is responsible for the observed 2.",
      "The subtraction operator explains why add returns 2.",
      "The function returns 2 because it subtracts right from left.",
      "Probe src/math.ts next.",
    ]) {
      const result = await scoreRun(
        {
          output: "Diagnosis: Incomplete",
          workspace: createTemporaryDirectory(),
          toolCalls,
          assistantMessages: [{ text, assistantTurn: 1 }],
        },
        [check]
      );
      expect(result.overall).toBe(0);
    }
  });

  it("withholds full exact-anchor score for a predicate diagnosis before reproduction", async () => {
    const corpus = parseCorpus(
      JSON.parse(readFileSync(join(moduleDirectory, "corpus.json"), "utf8"))
    );
    const checks = corpus.cases.find(
      (evalCase) => evalCase.id === "diagnose-exact-anchor"
    )?.checks;
    if (!checks) {
      throw new Error("diagnose exact-anchor case is missing");
    }

    const result = await scoreRun(
      {
        output:
          "Diagnosis: Incomplete\nFix: Not attempted\nThe tests/math.case.ts command bun test tests/math.case.ts shows add(7, 5) returned 2 instead of 12. src/math.ts contains left - right subtraction.",
        workspace: createTemporaryDirectory(),
        toolCalls: [
          {
            name: "bash",
            args: { command: "bun test tests/math.case.ts" },
            assistantTurn: 2,
            isError: true,
            resultText: "0 pass\n1 fail\nExpected add(7, 5) to be 12\n",
          },
        ],
        assistantMessages: [
          {
            text: "The subtraction operator explains why add returns 2.",
            assistantTurn: 1,
          },
        ],
      },
      checks
    );

    expect(result.overall).toBeLessThan(1);
    expect(
      result.checks.find(
        ({ check }) => check.type === "toolCallMatchesBeforeAssistantMatches"
      )?.passed
    ).toBe(false);
  });

  it("detects any workspace mutation instead of trusting preserved substrings", async () => {
    const workspace = createTemporaryDirectory();
    writeFileSync(join(workspace, "artifact.txt"), "original line\n");
    const initialWorkspaceSnapshot = await snapshotWorkspace(workspace);
    writeFileSync(
      join(workspace, "artifact.txt"),
      "original line\nappended mutation\n"
    );
    writeFileSync(join(workspace, "extra.txt"), "new file\n");

    const result = await scoreRun(
      { output: "done", workspace, initialWorkspaceSnapshot, toolCalls: [] },
      [
        {
          type: "workspaceUnchanged",
          domain: "tests",
          weight: 1,
        },
      ]
    );

    expect(result.overall).toBe(0);
    expect(result.checks[0]?.evidence).toBe("workspace changed");
  });

  it("rejects fix edits before the questionnaire even when another edit follows", async () => {
    const result = await scoreRun(
      {
        output: "done",
        workspace: createTemporaryDirectory(),
        toolCalls: [
          { name: "edit", args: { path: "src/math.ts" }, assistantTurn: 0 },
          {
            name: "questionnaire",
            args: { questions: [] },
            assistantTurn: 1,
            questionnaireResponse: "Approve scoped fix",
          },
          { name: "edit", args: { path: "src/math.ts" }, assistantTurn: 2 },
        ],
      },
      [
        {
          type: "toolCalledAfter",
          name: "edit",
          after: "questionnaire",
          domain: "tests",
          weight: 1,
        },
      ]
    );

    expect(result.overall).toBe(0);
  });

  it("rejects an edit in the same assistant turn as successful approval", async () => {
    const result = await scoreRun(
      {
        output: "done",
        workspace: createTemporaryDirectory(),
        toolCalls: [
          {
            name: "questionnaire",
            args: { questions: [] },
            assistantTurn: 0,
            isError: false,
            questionnaireResponse: "Approve scoped fix",
          },
          {
            name: "edit",
            args: { path: "src/math.ts" },
            assistantTurn: 0,
            isError: false,
          },
        ],
      },
      [
        {
          type: "toolCalledAfter",
          name: "edit",
          after: "questionnaire",
          domain: "tests",
          weight: 1,
        },
      ]
    );

    expect(result.overall).toBe(0);
  });

  it("rejects errored exact verification commands", async () => {
    const result = await scoreRun(
      {
        output: "Fix: Verified",
        workspace: createTemporaryDirectory(),
        toolCalls: [
          { name: "edit", args: {}, assistantTurn: 0, isError: false },
          {
            name: "bash",
            args: { command: "bun test tests/math.case.ts" },
            assistantTurn: 1,
            isError: true,
          },
        ],
      },
      [
        {
          type: "toolCalledAfter",
          name: "bash",
          after: "edit",
          args: { command: "bun test tests/math.case.ts" },
          domain: "tests",
          weight: 1,
        },
      ]
    );

    expect(result.overall).toBe(0);
  });

  it("reports missing artifacts instead of treating them as infrastructure errors", async () => {
    const result = await scoreRun(
      {
        output: "done",
        workspace: createTemporaryDirectory(),
        toolCalls: [],
      },
      [
        {
          type: "fileContains",
          path: "missing.txt",
          value: "value",
          domain: "task",
          weight: 1,
        },
      ]
    );

    expect(result.overall).toBe(0);
    expect(result.checks[0]?.evidence).toContain("missing file");
  });

  it("keeps weighted domains and efficiency deltas separate", async () => {
    const scored = await scoreRun(
      {
        output: "Evidence: src/math.ts subtracts.",
        workspace: createTemporaryDirectory(),
        toolCalls: [
          { name: "read", args: { path: "src/math.ts" }, assistantTurn: 0 },
        ],
      },
      [
        {
          type: "outputIncludes",
          value: "src/math.ts",
          domain: "evidence",
          weight: 1,
        },
        {
          type: "outputIncludes",
          value: "missing",
          domain: "quality",
          weight: 3,
        },
        {
          type: "toolCalled",
          name: "read",
          domain: "task",
          weight: 2,
        },
      ]
    );

    expect(scored.overall).toBe(0.5);
    expect(scored.domains).toEqual({
      evidence: 1,
      quality: 0,
      task: 1,
      tests: null,
    });

    const aggregate = aggregateVariants(
      [
        {
          score: 0.5,
          metrics: {
            ...createEmptyMetrics(),
            inputTokens: 100,
            latencyMs: 500,
          },
          succeeded: true,
        },
      ],
      [
        {
          score: 0.75,
          metrics: {
            ...createEmptyMetrics(),
            inputTokens: 80,
            latencyMs: 400,
          },
          succeeded: true,
        },
      ]
    );

    expect(aggregate.scoreDelta).toBe(0.25);
    expect(aggregate.baselineMetrics).toMatchObject({
      inputTokens: 100,
      latencyMs: 500,
    });
    expect(aggregate.candidateMetrics).toMatchObject({
      inputTokens: 80,
      latencyMs: 400,
    });
    expect(aggregate.inputTokenDelta).toBe(-20);
    expect(aggregate.latencyMsDelta).toBe(-100);
  });
});
