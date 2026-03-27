import { describe, expect, it } from "bun:test";

import { SessionManager } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

import {
  buildContextContentSnapshot,
  captureContextEventSnapshot,
} from "./content";
import {
  fitRenderedLinesToWidth,
  renderContextContentText,
} from "./content-view";

function makeCtx(
  sessionManager: SessionManager,
  systemPrompt = "system prompt"
) {
  return {
    sessionManager,
    model: undefined,
    modelRegistry: {
      find() {
        return undefined;
      },
    },
    getSystemPrompt() {
      return systemPrompt;
    },
  } as any;
}

describe("context content", () => {
  it("prefers a current cached context snapshot", () => {
    const sessionManager = SessionManager.inMemory("/tmp/context-content");
    sessionManager.appendThinkingLevelChange("high");
    sessionManager.appendModelChange("anthropic", "claude-test");
    sessionManager.appendMessage({
      role: "user",
      content: "live session message",
      timestamp: 1,
    });

    const ctx = makeCtx(sessionManager);
    const cachedSnapshot = captureContextEventSnapshot(ctx, [
      {
        role: "user",
        content: "cached message",
        timestamp: 2,
      } as any,
    ]);

    const snapshot = buildContextContentSnapshot(ctx, cachedSnapshot);

    expect(snapshot.source).toBe("context_event_snapshot");
    expect(snapshot.messageCount).toBe(1);
    expect(snapshot.messages[0]?.blocks[0]?.content).toBe("cached message");
    expect(snapshot.modelLabel).toBe("anthropic/claude-test");
    expect(snapshot.thinkingLevel).toBe("high");
  });

  it("falls back to reconstructed session context when the cache is stale", () => {
    const sessionManager = SessionManager.inMemory("/tmp/context-content");
    sessionManager.appendMessage({
      role: "user",
      content: "first message",
      timestamp: 1,
    });

    const ctx = makeCtx(sessionManager);
    const cachedSnapshot = captureContextEventSnapshot(ctx, [
      {
        role: "user",
        content: "cached message",
        timestamp: 2,
      } as any,
    ]);

    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second message" }],
      api: "anthropic",
      provider: "anthropic",
      model: "claude-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 3,
    });

    const snapshot = buildContextContentSnapshot(ctx, cachedSnapshot);

    expect(snapshot.source).toBe("reconstructed_session");
    expect(snapshot.messageCount).toBe(2);
    expect(snapshot.messages[0]?.blocks[0]?.content).toBe("first message");
    expect(snapshot.messages[1]?.blocks[0]?.content).toBe("second message");
  });

  it("renders readable debug text", () => {
    const output = renderContextContentText({
      source: "reconstructed_session",
      sourceNote:
        "Source: reconstructed current session context (no cached context snapshot yet).",
      systemPrompt: "You are helpful.",
      modelLabel: "anthropic/claude-test",
      thinkingLevel: "medium",
      messageCount: 2,
      messages: [
        {
          role: "user",
          title: "[1] user",
          metadata: [],
          blocks: [{ label: "content", content: "hello" }],
        },
        {
          role: "assistant",
          title: "[2] assistant",
          metadata: ["anthropic/claude-test", "stop=toolUse"],
          blocks: [
            { label: "text 1", content: "I'll inspect that." },
            {
              label: "tool call 2 · read",
              content: '{\n  "path": "README.md"\n}',
            },
          ],
        },
      ],
    });

    expect(output).toContain("/context content");
    expect(output).toContain("== System prompt ==");
    expect(output).toContain("== Messages (2) ==");
    expect(output).toContain("[tool call 2 · read]");
    expect(output).toContain('"path": "README.md"');
  });

  it("hard-clamps rendered lines to the target width", () => {
    const lines = fitRenderedLinesToWidth(["1234567890", "ok"], 8);

    expect(lines[0]).toContain("12345678");
    expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(8);
    expect(visibleWidth(lines[1] ?? "")).toBeLessThanOrEqual(8);
  });

  it("normalizes tabs before width clamping", () => {
    const lines = fitRenderedLinesToWidth(["a\t\tlong tabbed line"], 12);

    expect(lines[0]).not.toContain("\t");
    expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(12);
  });
});
