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
