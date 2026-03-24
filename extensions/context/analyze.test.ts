import { describe, expect, it } from "bun:test";

import { analyzeMessages, formatArtifactLabel } from "./analyze";

describe("analyzeMessages", () => {
  it("uses exact total when available and keeps residual explicit", () => {
    const snapshot = analyzeMessages({
      systemPrompt: "system prompt ".repeat(200),
      contextWindow: 20000,
      contextUsage: {
        tokens: 6000,
        contextWindow: 20000,
        percent: 30,
      },
      modelLabel: "claude-test",
      messages: [
        {
          role: "user",
          content: "user ".repeat(400),
          timestamp: 1,
        } as any,
        {
          role: "assistant",
          content: [
            { type: "text", text: "assistant ".repeat(600) },
            { type: "thinking", thinking: "thinking ".repeat(500) },
            {
              type: "toolCall",
              id: "1",
              name: "read",
              arguments: { path: "big.ts" },
            },
          ],
          timestamp: 2,
        } as any,
        {
          role: "toolResult",
          toolCallId: "1",
          toolName: "read",
          content: [{ type: "text", text: "file body ".repeat(700) }],
          isError: false,
          timestamp: 3,
        } as any,
      ],
    });

    expect(snapshot.modelLabel).toBe("claude-test");
    expect(snapshot.exactTotalTokens).toBe(6000);
    expect(snapshot.displayUsedTokens).toBeGreaterThanOrEqual(6000);
    expect(snapshot.severity).toBe("healthy");
    expect(snapshot.residualTokens).toBeGreaterThanOrEqual(0);
    expect(
      snapshot.displayCategories.find((category) => category.key === "messages")
        ?.tokens
    ).toBeGreaterThan(0);
    expect(snapshot.topOffenders[0]?.tokens).toBeGreaterThan(0);
  });

  it("flags unknown exact totals and uses estimated severity", () => {
    const snapshot = analyzeMessages({
      systemPrompt: "system prompt ".repeat(400),
      contextWindow: 10000,
      contextUsage: {
        tokens: null,
        contextWindow: 10000,
        percent: null,
      },
      messages: [
        {
          role: "user",
          content: "user ".repeat(1000),
          timestamp: 1,
        } as any,
        {
          role: "assistant",
          content: [{ type: "text", text: "assistant ".repeat(9000) }],
          timestamp: 2,
        } as any,
      ],
    });

    expect(snapshot.exactTotalTokens).toBeNull();
    expect(snapshot.severitySource).toBe("estimate");
    expect(snapshot.severity).toBe("critical");
    expect(
      snapshot.suggestions.some((item) => item.kind === "unknown_total")
    ).toBe(true);
    expect(snapshot.suggestions.some((item) => item.kind === "critical")).toBe(
      true
    );
  });

  it("best-effort splits system prompt sections", () => {
    const snapshot = analyzeMessages({
      contextWindow: 200000,
      systemPrompt: `You are an assistant.\n\nAvailable tools:\n- read\n- bash\n\nAvailable agent types:\n- general-purpose\n- code-reviewer\n\n# Project Context\n\n## /tmp/AGENTS.md\nProject instructions\n\n<rules>rule block</rules>\n\n<available_skills>skill block</available_skills>`,
      messages: [],
    });

    expect(
      snapshot.displayCategories.find(
        (category) => category.key === "system_tools"
      )?.tokens
    ).toBeGreaterThan(0);
    expect(
      snapshot.displayCategories.find(
        (category) => category.key === "custom_agents"
      )?.tokens
    ).toBeGreaterThan(0);
    expect(
      snapshot.displayCategories.find(
        (category) => category.key === "memory_files"
      )?.tokens
    ).toBeGreaterThan(0);
    expect(
      snapshot.displayCategories.find((category) => category.key === "skills")
        ?.tokens
    ).toBeGreaterThan(0);
  });

  it("keeps estimated categories visible when exact total is lower", () => {
    const snapshot = analyzeMessages({
      systemPrompt: "system prompt ".repeat(300),
      contextWindow: 200000,
      contextUsage: {
        tokens: 0,
        contextWindow: 200000,
        percent: 0,
      },
      messages: [],
    });

    expect(snapshot.exactTotalTokens).toBe(0);
    expect(
      snapshot.displayCategories.find(
        (category) => category.key === "system_prompt"
      )?.tokens
    ).toBeGreaterThan(0);
    expect(
      snapshot.displayCategories.find((category) => category.key === "residual")
        ?.tokens
    ).toBe(0);
    expect(snapshot.displayUsedTokens).toBeGreaterThan(0);
    expect(
      snapshot.suggestions.some((item) => item.kind === "overestimate")
    ).toBe(true);
  });

  it("formats offender labels with turn numbers", () => {
    expect(
      formatArtifactLabel({
        bucket: "tool_results",
        tokens: 42,
        turn: 3,
        source: "tool result: read",
      })
    ).toBe("t3 • tool result: read");
  });
});
