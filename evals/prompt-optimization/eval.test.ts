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

import { changedPromptPaths } from "./cli";
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

  it("accepts the diagnose skill prompt", () => {
    const corpus = parseCorpus({
      version: 1,
      cases: [
        {
          id: "diagnose",
          workload: "focused bug fix",
          promptPath: "skills/diagnose/SKILL.md",
          task: "Diagnose the failure.",
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
    });

    expect(corpus.cases[0]?.promptPath).toBe("skills/diagnose/SKILL.md");
  });

  it("rejects other skill prompts", () => {
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
    expectedPaths.push("skills/diagnose/SKILL.md");
    expect(coveredPaths).toEqual(new Set(expectedPaths));
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

  it("has exactly five diagnose cases with deterministic safety checks", () => {
    const corpus = parseCorpus(
      JSON.parse(readFileSync(join(moduleDirectory, "corpus.json"), "utf8"))
    );
    const diagnoseCases = corpus.cases.filter(
      (evalCase) => evalCase.promptPath === "skills/diagnose/SKILL.md"
    );

    expect(diagnoseCases.map((evalCase) => evalCase.id)).toEqual([
      "diagnose-exact-anchor",
      "diagnose-incomplete-no-fix",
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
});

describe("changedPromptPaths", () => {
  it("discovers only core, agent, and diagnose skill prompt changes", async () => {
    const repository = createTemporaryDirectory();
    run(repository, "git", ["init"]);
    run(repository, "git", ["config", "user.email", "eval@example.com"]);
    run(repository, "git", ["config", "user.name", "Eval Test"]);
    const paths = [
      "agents/explorer.md",
      "extensions/core-prompt/prompt.md",
      "skills/diagnose/SKILL.md",
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
    ]);
  });
});

describe("loadPromptPair", () => {
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
