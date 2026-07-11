import { describe, expect, it } from "bun:test";

import {
  createComparison,
  createVariantConfigs,
  parseCliOptions,
  validateReasoningComparison,
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
