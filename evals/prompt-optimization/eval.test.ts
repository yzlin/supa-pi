import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateVariants,
  CORE_EVAL_BASE_PROMPT,
  composePrompt,
  createEmptyMetrics,
  loadPromptPair,
  parseCorpus,
  reduceRunEvent,
  scoreRun,
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
  it("covers all seven target workloads and every changed prompt", () => {
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
    expect(coveredPaths).toEqual(new Set(expectedPaths));
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
        toolCalls: [{ name: "read", args: { path: "src/math.ts" } }],
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
