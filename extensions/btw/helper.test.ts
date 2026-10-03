import { describe, expect, it } from "bun:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  buildBtwConversationContext,
  parseBtwArgs,
  resolveModelAndThinking,
} from "./helper";

describe("buildBtwConversationContext", () => {
  function userMessage(text: string) {
    return { role: "user" as const, content: text, timestamp: Date.now() };
  }

  it("uses compacted context instead of the raw branch", () => {
    const sm = SessionManager.inMemory("/tmp");
    sm.appendMessage(userMessage("PRE_COMPACTION_ONLY"));
    const keptId = sm.appendMessage(userMessage("KEPT_AFTER_COMPACTION"));
    sm.appendCompaction("COMPACTION_SUMMARY", keptId, 1000);
    sm.appendMessage(userMessage("AFTER_COMPACTION"));
    sm.appendCustomMessageEntry("btw-result", "OLD_BTW_RESULT", true);

    const context = buildBtwConversationContext(
      sm.getEntries(),
      sm.getLeafId(),
    );

    expect(context).toContain("COMPACTION_SUMMARY");
    expect(context).toContain("KEPT_AFTER_COMPACTION");
    expect(context).toContain("AFTER_COMPACTION");
    expect(context).not.toContain("PRE_COMPACTION_ONLY");
    expect(context).not.toContain("OLD_BTW_RESULT");
  });

  it("returns empty text for an empty session", () => {
    const sm = SessionManager.inMemory("/tmp");
    expect(buildBtwConversationContext(sm.getEntries(), sm.getLeafId())).toBe(
      "",
    );
  });
});

describe("parseBtwArgs", () => {
  it("parses a leading -model option", () => {
    expect(
      parseBtwArgs("-model anthropic/claude-haiku-4-5 count lines of code"),
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
      return;
    },
  };

  it("returns the current model when no override is given", () => {
    const result = resolveModelAndThinking(
      modelRegistry,
      currentModel,
      "medium",
      {},
    );

    expect(result.model).toBe(currentModel);
    expect(result.thinkingLevel).toBe("medium");
    expect(result.error).toBeUndefined();
  });

  it("resolves a known provider/modelId override", () => {
    const result = resolveModelAndThinking(
      modelRegistry,
      currentModel,
      "medium",
      { model: "anthropic/claude-haiku-4-5" },
    );

    expect(result.model).toEqual({
      provider: "anthropic",
      id: "claude-haiku-4-5",
    });
    expect(result.thinkingLevel).toBe("medium");
    expect(result.error).toBeUndefined();
  });

  it("uses the scoped model and pinned thinking level", () => {
    const scopedModel = {
      provider: "anthropic",
      id: "claude-haiku-4-5",
    };
    const result = resolveModelAndThinking(
      modelRegistry,
      currentModel,
      "medium",
      { model: "anthropic/claude-haiku-4-5" },
      [{ model: scopedModel, thinkingLevel: "high" }],
    );

    expect(result).toEqual({ model: scopedModel, thinkingLevel: "high" });
  });

  it("rejects overrides outside the current model scope", () => {
    const result = resolveModelAndThinking(
      modelRegistry,
      currentModel,
      "medium",
      { model: "anthropic/claude-haiku-4-5" },
      [{ model: currentModel }],
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Model anthropic/claude-haiku-4-5 is outside the current model scope",
    );
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
