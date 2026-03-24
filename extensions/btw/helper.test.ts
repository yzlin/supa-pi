import { describe, expect, it } from "bun:test";

import { parseBtwArgs, resolveModelAndThinking } from "./helper";

describe("parseBtwArgs", () => {
  it("parses a leading -model option", () => {
    expect(
      parseBtwArgs("-model anthropic/claude-haiku-4-5 count lines of code")
    ).toEqual({
      model: "anthropic/claude-haiku-4-5",
      task: "count lines of code",
    });
  });

  it("keeps inline -model text inside the task", () => {
    expect(parseBtwArgs("explain the -model flag behavior")).toEqual({
      task: "explain the -model flag behavior",
    });
  });
});

describe("resolveModelAndThinking", () => {
  const currentModel = { provider: "openai", id: "gpt-5" };
  const modelRegistry = {
    find(provider: string, modelId: string) {
      if (provider === "anthropic" && modelId === "claude-haiku-4-5") {
        return { provider, id: modelId };
      }
      return undefined;
    },
  };

  it("returns the current model when no override is given", () => {
    const result = resolveModelAndThinking(modelRegistry, currentModel, "medium", {});

    expect(result.model).toBe(currentModel);
    expect(result.thinkingLevel).toBe("medium");
    expect(result.error).toBeUndefined();
  });

  it("resolves a known provider/modelId override", () => {
    const result = resolveModelAndThinking(
      modelRegistry,
      currentModel,
      "medium",
      { model: "anthropic/claude-haiku-4-5" }
    );

    expect(result.model).toEqual({
      provider: "anthropic",
      id: "claude-haiku-4-5",
    });
    expect(result.thinkingLevel).toBe("medium");
    expect(result.error).toBeUndefined();
  });

  it("fails fast on invalid model format", () => {
    const result = resolveModelAndThinking(modelRegistry, currentModel, "low", {
      model: "haiku",
    });

    expect(result.model).toBeUndefined();
    expect(result.error).toContain("Invalid model format");
  });

  it("fails fast on unknown models", () => {
    const result = resolveModelAndThinking(modelRegistry, currentModel, "low", {
      model: "anthropic/unknown-model",
    });

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model anthropic/unknown-model");
  });
});
