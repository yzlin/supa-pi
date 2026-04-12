import { describe, expect, it } from "bun:test";

import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@mariozechner/pi-coding-agent";

import { renderStatusBarLine } from "./status-bar";

describe("status bar", () => {
  it("renders model, git branch, and context for the compact preset", () => {
    const ctx = {
      model: {
        id: "test-model",
        name: "test-model",
        reasoning: false,
        contextWindow: 200000,
      },
      modelRegistry: {},
      sessionManager: {
        getBranch() {
          return [];
        },
        getSessionId() {
          return "session-12345678";
        },
      },
      getContextUsage() {
        return {
          tokens: 25000,
          contextWindow: 200000,
          percent: 12.5,
        };
      },
    } as unknown as ExtensionContext;

    const footerData = {
      getGitBranch() {
        return "main";
      },
      getExtensionStatuses() {
        return new Map();
      },
      getAvailableProviderCount() {
        return 0;
      },
      onBranchChange() {
        return () => {};
      },
    } satisfies ReadonlyFooterDataProvider;

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
    } as any;

    const line = renderStatusBarLine({
      width: 120,
      ctx,
      footerData,
      preset: "compact",
      sessionStartTime: Date.now(),
      theme,
    });

    expect(line).toContain("test-model");
    expect(line).toContain("main");
    expect(line).toContain("12.5%/200k");
  });
});
