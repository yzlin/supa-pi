import { describe, expect, it } from "bun:test";

import {
  createComparison,
  createVariantConfigs,
  parseCliOptions,
  validateReasoningComparison,
  validateServiceTierComparison,
  validateServiceTierEvidence,
} from "./cli";

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
