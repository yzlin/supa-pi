import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configuredPrimaryModel,
  createComparison,
  createVariantConfigs,
  modelSelectionRecord,
  parseCliOptions,
  plannedCallMessage,
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
