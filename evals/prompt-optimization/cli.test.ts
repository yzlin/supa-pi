import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";

import {
  configuredPrimaryModel,
  createComparison,
  createVariantConfigs,
  modelForVariant,
  modelSelectionRecord,
  parseCliOptions,
  plannedCallMessage,
  resolveModelComparison,
  singleArmManifestFields,
  TASK_SHAPE_CASE_IDS,
  taskShapeSummaryMarkdown,
  validateReasoningComparison,
  validateServiceTierComparison,
  validateServiceTierEvidence,
} from "./cli";
import {
  aggregatePersistedTaskShapeRuns,
  loadTaskShapeCorpus,
} from "./task-shape";

const PROMPT_HASHES_PATTERN =
  /Prompt agents\/explorer\.md: baseline working-tree sha256=[a-f0-9]{64}; candidate working-tree sha256=[a-f0-9]{64}/;
const CORE_PROMPT_HASH_PATTERN = /Core eval base prompt sha256=[a-f0-9]{64}/;

async function snapshotDirectory(path: string): Promise<string[] | null> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

describe("Task-shape artifact summaries", () => {
  it("aggregates persisted taskShapeEvidence into JSON and Markdown counts", async () => {
    const runsDirectory = await mkdtemp(join(tmpdir(), "task-shape-runs-"));
    try {
      const corpus = loadTaskShapeCorpus();
      const records = corpus.cases.flatMap((evalCase) =>
        Array.from({ length: 3 }, (_, index) => ({
          caseId: evalCase.id,
          repetition: index + 1,
          variant: "candidate",
          taskShapeEvidence: {
            structurallyValid: true,
            classificationCorrect: true,
            shapeCorrect: true,
            invalidOrOversizedTddAttempts: 0,
            attemptedTaskCount: evalCase.expected.length,
            expectedTaskCount: evalCase.expected.length,
            attempts: [],
          },
        }))
      );
      records[0]!.taskShapeEvidence.structurallyValid = false;
      for (const record of records.slice(0, 9)) {
        record.taskShapeEvidence.classificationCorrect = false;
      }
      await Promise.all(
        records.map((record) =>
          writeFile(
            join(
              runsDirectory,
              `${record.caseId}-${record.variant}-r${record.repetition}.json`
            ),
            `${JSON.stringify(record, null, 2)}\n`
          )
        )
      );

      const summary = await aggregatePersistedTaskShapeRuns(
        runsDirectory,
        corpus
      );
      expect(JSON.parse(JSON.stringify(summary))).toMatchObject({
        plannedRunsValid: true,
        structuralValidRuns: 23,
        classificationCorrectRuns: 15,
        invalidOrOversizedTddAttempts: 0,
      });
      expect(taskShapeSummaryMarkdown(summary)).toContain(
        "| Structurally valid runs | 23/24 |"
      );
      expect(taskShapeSummaryMarkdown(summary)).toContain(
        "| Correct classification and shape | 15/24 |"
      );
    } finally {
      await rm(runsDirectory, { recursive: true, force: true });
    }
  });
});

describe("dry-run CLI", () => {
  it("prints an offline bounded model-comparison preview before live side effects", async () => {
    const isolatedRoot = await mkdtemp(join(tmpdir(), "prompt-eval-dry-"));
    const emptyHome = join(isolatedRoot, "home");
    const isolatedTmp = join(isolatedRoot, "tmp");
    await Promise.all([mkdir(emptyHome), mkdir(isolatedTmp)]);
    const temporaryEntriesBefore = await snapshotDirectory(isolatedTmp);
    const artifactsDirectory = resolve(import.meta.dir, "../../.pi/evals");
    const artifactsBefore = await snapshotDirectory(artifactsDirectory);
    try {
      const child = spawn({
        cmd: [
          process.execPath,
          resolve(import.meta.dir, "cli.ts"),
          "--dry-run",
          "--case",
          "explore-root-cause",
          "--model",
          "synthetic/baseline",
          "--candidate-model",
          "synthetic/candidate",
          "--thinking",
          "high",
          "--repetitions",
          "2",
          "--max-turns",
          "3",
          "--timeout-ms",
          "1234",
        ],
        cwd: resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          HOME: emptyHome,
          TMPDIR: isolatedTmp,
          SUPA_PI_EVAL_FORBID_LIVE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(
        "DRY RUN — no model runtime, credentials, network, fixture copies, or eval artifacts"
      );
      expect(stdout).toContain("Cases (1): explore-root-cause");
      expect(stdout).toContain("Mode: model comparison");
      expect(stdout).toContain(
        "baseline: requested synthetic/baseline (unresolved/unverified); effort high; prompt working-tree"
      );
      expect(stdout).toContain(
        "candidate: requested synthetic/candidate (unresolved/unverified); effort high; prompt working-tree"
      );
      expect(stdout).toContain("Repetitions: 2");
      expect(stdout).toContain(
        "RUNS: 4 (1 case(s) × 2 repetition(s) × 2 arms)"
      );
      expect(stdout).toContain(
        "MODEL RESPONSE turns: at most 12 (4 runs × maxTurns 3)"
      );
      expect(stdout).toContain(
        "maxTurns: 3 per run; timeout: 1234 ms per run (abort deadline)"
      );
      expect(stdout).toContain(
        "Transport attempts/retries: not bounded by maxTurns; provider retry behavior is unresolved/unverified"
      );
      expect(stdout).toMatch(PROMPT_HASHES_PATTERN);
      expect(stdout).toMatch(CORE_PROMPT_HASH_PATTERN);
      expect(stdout).toContain(
        "Live transmission: evaluated system prompt, case task, conversation messages, tool calls/results, and fixture contents exposed through tools go to each requested model provider"
      );
      expect(stdout).toContain("Cost: unknown; token budget: none");
      expect(await snapshotDirectory(artifactsDirectory)).toEqual(
        artifactsBefore
      );
      expect(await snapshotDirectory(isolatedTmp)).toEqual(
        temporaryEntriesBefore
      );
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("exposes --dry-run in help and validates cases without entering live mode", async () => {
    const cliPath = resolve(import.meta.dir, "cli.ts");
    const cwd = resolve(import.meta.dir, "../..");
    const help = spawn({
      cmd: [process.execPath, cliPath, "--help"],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const invalid = spawn({
      cmd: [process.execPath, cliPath, "--dry-run", "--case", "not-a-case"],
      cwd,
      env: { ...process.env, SUPA_PI_EVAL_FORBID_LIVE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [helpCode, helpOutput, invalidCode, invalidError] = await Promise.all(
      [
        help.exited,
        new Response(help.stdout).text(),
        invalid.exited,
        new Response(invalid.stderr).text(),
      ]
    );

    expect(helpCode).toBe(0);
    expect(helpOutput).toContain("--dry-run");
    expect(invalidCode).toBe(1);
    expect(invalidError).toContain("unknown eval case: not-a-case");
    expect(invalidError).not.toContain("live execution forbidden");
  });
});

describe("parseCliOptions", () => {
  it("keeps thinking shared in prompt comparison mode", () => {
    const options = parseCliOptions(["--thinking", "medium"]);

    expect(options).toMatchObject({ caseIds: [], thinking: "medium" });
    expect(options.candidateThinking).toBeUndefined();
  });

  it("parses a reasoning comparison and repeated cases", () => {
    expect(
      parseCliOptions([
        "--thinking",
        "high",
        "--candidate-thinking",
        "medium",
        "--case",
        "core-orchestration",
        "--case",
        "executor-fix",
        "--case",
        "core-orchestration",
      ])
    ).toMatchObject({
      caseIds: ["core-orchestration", "executor-fix"],
      thinking: "high",
      candidateThinking: "medium",
    });
  });

  it("parses the bounded single-arm Task-shape suite", () => {
    const options = parseCliOptions(["--task-shape-suite"]);

    expect(options).toMatchObject({
      taskShapeSuite: true,
      repetitions: 3,
      caseIds: [],
    });
    expect(TASK_SHAPE_CASE_IDS).toHaveLength(8);
    expect(plannedCallMessage(8, options.repetitions, true)).toBe(
      "Running 24 live calls: 8 case(s) × 3 repetition(s) × 1 candidate arm\n"
    );
    expect(singleArmManifestFields(24)).toEqual({
      mode: "task-shape-suite",
      plannedCalls: 24,
      arm: { variant: "candidate", promptSource: "working-tree" },
    });
  });

  it("rejects flags incompatible with the Task-shape suite", () => {
    expect(() =>
      parseCliOptions(["--task-shape-suite", "--case", "build-fix"])
    ).toThrow("cannot be combined with --case");
    expect(() =>
      parseCliOptions(["--task-shape-suite", "--candidate-thinking", "low"])
    ).toThrow("cannot be combined with paired comparison flags");
    expect(() =>
      parseCliOptions(["--task-shape-suite", "--repetitions", "2"])
    ).toThrow("requires exactly 3 repetitions");
  });

  it("resolves the Task-shape model from the configured primary or override", () => {
    const settings = {
      getDefaultProvider: () => "configured-provider",
      getDefaultModel: () => "configured-model",
    };

    expect(configuredPrimaryModel(undefined, settings)).toBe(
      "configured-provider/configured-model"
    );
    expect(configuredPrimaryModel("override/model", settings)).toBe(
      "override/model"
    );
    expect(
      modelSelectionRecord(
        "configured-provider/configured-model",
        "configured-provider/exact-model-id",
        false
      )
    ).toEqual({
      source: "configured-primary",
      selectedAtStart: "configured-provider/configured-model",
      resolved: "configured-provider/exact-model-id",
    });
  });

  it("parses an exact model comparison", () => {
    const options = parseCliOptions([
      "--model",
      "synthetic/baseline",
      "--candidate-model",
      "synthetic/candidate",
      "--thinking",
      "high",
      "--dry-run",
    ]);

    expect(options).toMatchObject({
      model: "synthetic/baseline",
      candidateModel: "synthetic/candidate",
      thinking: "high",
      dryRun: true,
    });
    expect(createComparison(options)).toEqual({
      kind: "model",
      baseline: {
        thinking: "high",
        promptSource: "working-tree",
        requestedModel: "synthetic/baseline",
      },
      candidate: {
        thinking: "high",
        promptSource: "working-tree",
        requestedModel: "synthetic/candidate",
      },
    });
  });

  it("rejects incomplete or combined model comparison modes", () => {
    expect(() =>
      parseCliOptions(["--candidate-model", "synthetic/candidate"])
    ).toThrow("requires an explicit --model baseline");
    expect(() =>
      parseCliOptions([
        "--model",
        "synthetic/baseline",
        "--candidate-model",
        "synthetic/candidate",
        "--candidate-thinking",
        "medium",
      ])
    ).toThrow("cannot combine model comparison");
    expect(() =>
      parseCliOptions([
        "--model",
        "synthetic/baseline",
        "--candidate-model",
        "synthetic/candidate",
        "--compare-service-tier",
      ])
    ).toThrow("cannot combine model comparison");
    expect(() =>
      parseCliOptions([
        "--model",
        "synthetic/baseline",
        "--candidate-model",
        "synthetic/candidate",
        "--task-shape-suite",
      ])
    ).toThrow("cannot be combined with paired comparison flags");
  });

  it("resolves both model arms exactly and preserves arm identity", () => {
    const baseline = {
      provider: "synthetic",
      id: "baseline",
      reasoning: true,
      thinkingLevelMap: { high: "high" },
    };
    const candidate = {
      provider: "synthetic",
      id: "candidate",
      reasoning: true,
      thinkingLevelMap: { high: "high" },
    };
    const selection = resolveModelComparison(
      "synthetic/baseline",
      "synthetic/candidate",
      "high",
      [baseline, candidate]
    );

    expect(modelForVariant(selection, "baseline")).toBe(baseline);
    expect(modelForVariant(selection, "candidate")).toBe(candidate);
    expect(selection.comparison).toEqual({
      kind: "model",
      baseline: {
        thinking: "high",
        promptSource: "working-tree",
        requestedModel: "synthetic/baseline",
        resolvedModel: "synthetic/baseline",
      },
      candidate: {
        thinking: "high",
        promptSource: "working-tree",
        requestedModel: "synthetic/candidate",
        resolvedModel: "synthetic/candidate",
      },
    });
    expect(() =>
      resolveModelComparison("synthetic/base", "synthetic/candidate", "high", [
        baseline,
        candidate,
      ])
    ).toThrow("exact model not found: synthetic/base");
  });

  it("rejects the same resolved model and incomparable effective effort", () => {
    const baseline = {
      provider: "synthetic",
      id: "baseline",
      reasoning: true,
    };
    const candidate = {
      provider: "synthetic",
      id: "candidate",
      reasoning: true,
      thinkingLevelMap: { minimal: "low", high: null },
    };

    expect(() =>
      resolveModelComparison(
        "synthetic/baseline",
        "SYNTHETIC/BASELINE",
        "high",
        [baseline, candidate]
      )
    ).toThrow("must resolve to different models");
    expect(() =>
      resolveModelComparison(
        "synthetic/baseline",
        "synthetic/candidate",
        "high",
        [baseline, candidate]
      )
    ).toThrow("candidate model does not support thinking level: high");
    expect(() =>
      resolveModelComparison(
        "synthetic/baseline",
        "synthetic/candidate",
        "minimal",
        [baseline, candidate]
      )
    ).toThrow(
      "effective thinking efforts are not comparable: minimal versus low"
    );
  });

  it("parses a service-tier comparison", () => {
    const options = parseCliOptions([
      "--compare-service-tier",
      "--thinking",
      "medium",
      "--repetitions",
      "4",
    ]);

    expect(options).toMatchObject({
      compareServiceTier: true,
      thinking: "medium",
    });
    expect(createComparison(options)).toEqual({
      kind: "service-tier",
      baseline: {
        thinking: "medium",
        promptSource: "working-tree",
        serviceTier: "default",
      },
      candidate: {
        thinking: "medium",
        promptSource: "working-tree",
        serviceTier: "priority",
      },
    });
  });

  it("rejects identical reasoning levels", () => {
    expect(() =>
      parseCliOptions([
        "--thinking",
        "medium",
        "--candidate-thinking",
        "medium",
      ])
    ).toThrow("reasoning comparison requires different thinking levels");
  });

  it("rejects an invalid candidate thinking level", () => {
    expect(() => parseCliOptions(["--candidate-thinking"])).toThrow(
      "--candidate-thinking must be one of:"
    );
  });

  it("rejects odd service-tier repetitions", () => {
    expect(() =>
      parseCliOptions(["--compare-service-tier", "--repetitions", "3"])
    ).toThrow("requires an even repetition count");
  });

  it("rejects combined reasoning and service-tier comparisons", () => {
    expect(() =>
      parseCliOptions([
        "--compare-service-tier",
        "--thinking",
        "high",
        "--candidate-thinking",
        "medium",
      ])
    ).toThrow("cannot combine");
  });

  it("limits service-tier comparison to Codex Responses models", () => {
    const comparison = createComparison(
      parseCliOptions(["--compare-service-tier", "--repetitions", "4"])
    );

    expect(() =>
      validateServiceTierComparison({ api: "openai-responses" }, comparison)
    ).toThrow("requires an openai-codex Responses model");
    expect(() =>
      validateServiceTierComparison(
        { api: "openai-codex-responses" },
        comparison
      )
    ).not.toThrow();
  });

  it("describes reasoning arms for artifact manifests", () => {
    const options = parseCliOptions([
      "--thinking",
      "high",
      "--candidate-thinking",
      "medium",
    ]);

    expect(createComparison(options)).toEqual({
      kind: "reasoning",
      baseline: { thinking: "high", promptSource: "working-tree" },
      candidate: { thinking: "medium", promptSource: "working-tree" },
    });
  });

  it("rejects unsupported or equivalent provider efforts", () => {
    const comparison = createComparison(
      parseCliOptions(["--thinking", "high", "--candidate-thinking", "medium"])
    );

    expect(() =>
      validateReasoningComparison(
        { reasoning: false, thinkingLevelMap: undefined },
        comparison
      )
    ).toThrow("does not support reasoning");
    expect(() =>
      validateReasoningComparison(
        { reasoning: true, thinkingLevelMap: { medium: null } },
        comparison
      )
    ).toThrow("does not support candidate thinking level: medium");
    expect(() =>
      validateReasoningComparison(
        {
          reasoning: true,
          thinkingLevelMap: { high: "same", medium: "same" },
        },
        comparison
      )
    ).toThrow("map to the same provider effort");
  });
});

describe("validateServiceTierEvidence", () => {
  const comparison = createComparison(
    parseCliOptions(["--compare-service-tier", "--repetitions", "4"])
  );

  it("accepts observed default and priority payload arms", () => {
    expect(() =>
      validateServiceTierEvidence(
        [
          {
            caseId: "case-a",
            variant: "baseline",
            repetition: 1,
            payloadServiceTier: "absent",
          },
          {
            caseId: "case-a",
            variant: "candidate",
            repetition: 1,
            payloadServiceTier: "priority",
          },
        ],
        comparison
      )
    ).not.toThrow();
  });

  it.each([
    undefined,
    "absent",
    "mixed",
  ])("rejects candidate payload evidence: %s", (payloadServiceTier) => {
    expect(() =>
      validateServiceTierEvidence(
        [
          {
            caseId: "case-a",
            variant: "candidate",
            repetition: 2,
            payloadServiceTier,
          },
        ],
        comparison
      )
    ).toThrow("invalid service-tier payload evidence for case-a candidate r2");
  });

  it("rejects a priority baseline payload", () => {
    expect(() =>
      validateServiceTierEvidence(
        [
          {
            caseId: "case-a",
            variant: "baseline",
            repetition: 3,
            payloadServiceTier: "priority",
          },
        ],
        comparison
      )
    ).toThrow("expected absent, got priority");
  });
});

describe("createVariantConfigs", () => {
  const promptPair = {
    baseline: { content: "HEAD bytes\n", sha256: "head-hash" },
    candidate: { content: "working-tree bytes", sha256: "working-hash" },
  };

  it("keeps HEAD versus working-tree prompts in prompt mode", () => {
    expect(
      createVariantConfigs(promptPair, {
        thinking: "high",
      })
    ).toEqual({
      baseline: {
        promptContent: "HEAD bytes\n",
        promptSha256: "head-hash",
        thinking: "high",
      },
      candidate: {
        promptContent: "working-tree bytes",
        promptSha256: "working-hash",
        thinking: "high",
      },
    });
  });

  it("uses identical working-tree prompts and effort in service-tier mode", () => {
    expect(
      createVariantConfigs(promptPair, {
        thinking: "medium",
        compareServiceTier: true,
      })
    ).toEqual({
      baseline: {
        promptContent: "working-tree bytes",
        promptSha256: "working-hash",
        thinking: "medium",
        serviceTier: "default",
      },
      candidate: {
        promptContent: "working-tree bytes",
        promptSha256: "working-hash",
        thinking: "medium",
        serviceTier: "priority",
      },
    });
  });

  it("uses identical working-tree prompts and effort in model mode", () => {
    expect(
      createVariantConfigs(promptPair, {
        thinking: "high",
        candidateModel: "synthetic/candidate",
      })
    ).toEqual({
      baseline: {
        promptContent: "working-tree bytes",
        promptSha256: "working-hash",
        thinking: "high",
      },
      candidate: {
        promptContent: "working-tree bytes",
        promptSha256: "working-hash",
        thinking: "high",
      },
    });
  });

  it("uses identical working-tree prompts in reasoning mode", () => {
    expect(
      createVariantConfigs(promptPair, {
        thinking: "high",
        candidateThinking: "medium",
      })
    ).toEqual({
      baseline: {
        promptContent: "working-tree bytes",
        promptSha256: "working-hash",
        thinking: "high",
      },
      candidate: {
        promptContent: "working-tree bytes",
        promptSha256: "working-hash",
        thinking: "medium",
      },
    });
  });
});
