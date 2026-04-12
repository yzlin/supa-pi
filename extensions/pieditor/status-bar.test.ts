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
      config: {
        enabled: true,
        preset: "compact",
      },
      sessionStartTime: Date.now(),
      theme,
    });

    expect(line).toContain("test-model");
    expect(line).toContain("main");
    expect(line).toContain("12.5%/200k");
  });

  it("renders configured left and right segments independently", () => {
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
      width: 40,
      ctx,
      footerData,
      config: {
        enabled: true,
        preset: "default",
        leftSegments: ["model"],
        rightSegments: ["context_pct"],
      },
      sessionStartTime: Date.now(),
      theme,
    });

    const modelIndex = line.indexOf("test-model");
    const contextIndex = line.indexOf("12.5%/200k");

    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(contextIndex).toBeGreaterThan(modelIndex + "test-model".length);
    expect(contextIndex - (modelIndex + "test-model".length)).toBeGreaterThan(
      1
    );
    expect(line).not.toContain("main");
  });

  it("treats separator names as literal text when configured", () => {
    const originalNerdFonts = process.env.POWERLINE_NERD_FONTS;
    process.env.POWERLINE_NERD_FONTS = "0";

    try {
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
        fg(color: string, text: string) {
          return `<${color}:${text}>`;
        },
      } as any;

      const line = renderStatusBarLine({
        width: 80,
        ctx,
        footerData,
        config: {
          enabled: true,
          preset: "default",
          leftSegments: ["model", "path"],
          rightSegments: [],
          separator: "pipe",
          colors: {
            separator: "muted",
          },
        },
        sessionStartTime: Date.now(),
        theme,
      });

      expect(line).toContain("<muted:pipe>");
      expect(line).not.toContain("<muted:|>");
    } finally {
      if (originalNerdFonts === undefined) {
        delete process.env.POWERLINE_NERD_FONTS;
      } else {
        process.env.POWERLINE_NERD_FONTS = originalNerdFonts;
      }
    }
  });

  it("applies configured separator and colors on top of the preset", () => {
    const originalNerdFonts = process.env.POWERLINE_NERD_FONTS;
    process.env.POWERLINE_NERD_FONTS = "0";

    try {
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
        fg(color: string, text: string) {
          return `<${color}:${text}>`;
        },
      } as any;

      const line = renderStatusBarLine({
        width: 80,
        ctx,
        footerData,
        config: {
          enabled: true,
          preset: "default",
          leftSegments: ["model", "path"],
          rightSegments: [],
          separator: " => ",
          colors: {
            model: "success",
            separator: "muted",
          },
        },
        sessionStartTime: Date.now(),
        theme,
      });

      expect(line).toContain("<success:✦ test-model>");
      expect(line).toContain("<muted: => >");
    } finally {
      if (originalNerdFonts === undefined) {
        delete process.env.POWERLINE_NERD_FONTS;
      } else {
        process.env.POWERLINE_NERD_FONTS = originalNerdFonts;
      }
    }
  });

  it("uses the refreshed nerd-font model icon by default", () => {
    const originalNerdFonts = process.env.POWERLINE_NERD_FONTS;
    process.env.POWERLINE_NERD_FONTS = "1";

    try {
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
        width: 40,
        ctx,
        footerData,
        config: {
          enabled: true,
          preset: "default",
          leftSegments: ["model"],
          rightSegments: [],
        },
        sessionStartTime: Date.now(),
        theme,
      });

      expect(line).toContain("\u{f544} test-model");
    } finally {
      if (originalNerdFonts === undefined) {
        delete process.env.POWERLINE_NERD_FONTS;
      } else {
        process.env.POWERLINE_NERD_FONTS = originalNerdFonts;
      }
    }
  });

  it("applies configured segment options on top of the preset", () => {
    const originalNerdFonts = process.env.POWERLINE_NERD_FONTS;
    process.env.POWERLINE_NERD_FONTS = "0";

    try {
      const ctx = {
        model: {
          id: "test-model",
          name: "test-model",
          reasoning: true,
          contextWindow: 200000,
        },
        modelRegistry: {},
        sessionManager: {
          getBranch() {
            return [
              {
                type: "thinking_level_change",
                thinkingLevel: "high",
              },
            ];
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
        width: 60,
        ctx,
        footerData,
        config: {
          enabled: true,
          preset: "default",
          leftSegments: ["model"],
          rightSegments: [],
          segmentOptions: {
            model: { showThinkingLevel: true },
          },
        },
        sessionStartTime: Date.now(),
        theme,
      });

      expect(line).toContain("test-model");
      expect(line).toContain("[high]");
    } finally {
      if (originalNerdFonts === undefined) {
        delete process.env.POWERLINE_NERD_FONTS;
      } else {
        process.env.POWERLINE_NERD_FONTS = originalNerdFonts;
      }
    }
  });

  it("right-aligns right-only configured segments", () => {
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
      width: 30,
      ctx,
      footerData,
      config: {
        enabled: true,
        preset: "default",
        leftSegments: [],
        rightSegments: ["context_pct"],
      },
      sessionStartTime: Date.now(),
      theme,
    });

    expect(line.trimStart()).toContain("12.5%/200k");
    expect(line.endsWith("12.5%/200k ")).toBe(true);
  });
});
