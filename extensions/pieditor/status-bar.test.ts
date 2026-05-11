import { describe, expect, it } from "bun:test";

import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";

import { buildAmpStatusLayout, renderStatusBarLine } from "./status-bar";

const CAVEMAN_STATUS_TEXT = "🪨 caveman";

function createStatusBarHarness() {
  const ctx = {
    model: {
      id: "test-model",
      name: "test-model",
      reasoning: false,
      contextWindow: 200_000,
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
        tokens: 25_000,
        contextWindow: 200_000,
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
      return () => {
        /* noop */
      };
    },
  } satisfies ReadonlyFooterDataProvider;

  const theme = {
    fg(_color: string, text: string) {
      return text;
    },
  } as any;

  return { ctx, footerData, theme };
}

describe("status bar", () => {
  describe("Amp status layout", () => {
    it("keeps normal visible segments in top content", () => {
      const { ctx, footerData, theme } = createStatusBarHarness();

      const layout = buildAmpStatusLayout({
        ctx,
        footerData,
        config: {
          enabled: true,
          preset: "default",
          leftSegments: ["model", "context_pct"],
          rightSegments: [],
          separator: " | ",
        },
        sessionStartTime: Date.now(),
        theme,
      });

      expect(layout.topLeftContent).toContain("test-model");
      expect(layout.topLeftContent).toContain("12.5%/200k");
      expect(layout.topRightContent).toBe("");
      expect(layout.bottomContent).toBe("");
    });

    it("moves configured path and git segments to bottom content", () => {
      const { ctx, footerData, theme } = createStatusBarHarness();

      const layout = buildAmpStatusLayout({
        ctx,
        footerData,
        config: {
          enabled: true,
          preset: "default",
          leftSegments: ["model", "path"],
          rightSegments: ["git", "context_pct"],
          separator: " | ",
        },
        sessionStartTime: Date.now(),
        theme,
      });

      expect(layout.topLeftContent).toContain("test-model");
      expect(layout.topRightContent).toContain("12.5%/200k");
      expect(layout.topLeftContent).not.toContain("supa-pi");
      expect(layout.topRightContent).not.toContain("main");
      expect(layout.bottomContent).toContain("supa-pi");
      expect(layout.bottomContent).toContain("main");
      expect(layout.bottomContent.indexOf("supa-pi")).toBeLessThan(
        layout.bottomContent.indexOf("main")
      );
    });

    it("does not duplicate path or git between top and bottom content", () => {
      const { ctx, footerData, theme } = createStatusBarHarness();

      const layout = buildAmpStatusLayout({
        ctx,
        footerData,
        config: {
          enabled: true,
          preset: "default",
          leftSegments: ["path", "model", "git"],
          rightSegments: [],
        },
        sessionStartTime: Date.now(),
        theme,
      });

      expect(layout.topLeftContent).toContain("test-model");
      expect(layout.topLeftContent).not.toContain("supa-pi");
      expect(layout.topLeftContent).not.toContain("main");
      expect(layout.topRightContent).toBe("");
      expect(layout.bottomContent).toContain("supa-pi");
      expect(layout.bottomContent).toContain("main");
    });

    it("honors custom left and right presence control", () => {
      const { ctx, footerData, theme } = createStatusBarHarness();

      const layout = buildAmpStatusLayout({
        ctx,
        footerData,
        config: {
          enabled: true,
          preset: "default",
          leftSegments: ["path"],
          rightSegments: ["model"],
        },
        sessionStartTime: Date.now(),
        theme,
      });

      expect(layout.topLeftContent).toBe("");
      expect(layout.topRightContent).toContain("test-model");
      expect(layout.topRightContent).not.toContain("main");
      expect(layout.bottomContent).toContain("supa-pi");
      expect(layout.bottomContent).not.toContain("main");
    });

    it("returns empty labels when disabled or context is missing", () => {
      const { ctx, footerData, theme } = createStatusBarHarness();

      expect(
        buildAmpStatusLayout({
          ctx,
          footerData,
          config: { enabled: false, preset: "default" },
          sessionStartTime: Date.now(),
          theme,
        })
      ).toEqual({
        topLeftContent: "",
        topRightContent: "",
        bottomContent: "",
      });
      expect(
        buildAmpStatusLayout({
          ctx: null,
          footerData,
          config: { enabled: true, preset: "default" },
          sessionStartTime: Date.now(),
          theme,
        })
      ).toEqual({
        topLeftContent: "",
        topRightContent: "",
        bottomContent: "",
      });
    });
  });

  it("renders model, git branch, and context for the compact preset", () => {
    const ctx = {
      model: {
        id: "test-model",
        name: "test-model",
        reasoning: false,
        contextWindow: 200_000,
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
          tokens: 25_000,
          contextWindow: 200_000,
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
        return () => {
          /* noop */
        };
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
        contextWindow: 200_000,
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
          tokens: 25_000,
          contextWindow: 200_000,
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
        return () => {
          /* noop */
        };
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
          contextWindow: 200_000,
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
            tokens: 25_000,
            contextWindow: 200_000,
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
          return () => {
            /* noop */
          };
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
        process.env.POWERLINE_NERD_FONTS = undefined;
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
          contextWindow: 200_000,
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
            tokens: 25_000,
            contextWindow: 200_000,
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
          return () => {
            /* noop */
          };
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
        process.env.POWERLINE_NERD_FONTS = undefined;
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
          contextWindow: 200_000,
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
            tokens: 25_000,
            contextWindow: 200_000,
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
          return () => {
            /* noop */
          };
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
        process.env.POWERLINE_NERD_FONTS = undefined;
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
          contextWindow: 200_000,
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
            tokens: 25_000,
            contextWindow: 200_000,
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
          return () => {
            /* noop */
          };
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
        process.env.POWERLINE_NERD_FONTS = undefined;
      } else {
        process.env.POWERLINE_NERD_FONTS = originalNerdFonts;
      }
    }
  });

  it("renders active caveman status as a dedicated status segment", () => {
    const ctx = {
      model: {
        id: "test-model",
        name: "test-model",
        reasoning: false,
        contextWindow: 200_000,
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
          tokens: 25_000,
          contextWindow: 200_000,
          percent: 12.5,
        };
      },
    } as unknown as ExtensionContext;

    const footerData = {
      getGitBranch() {
        return "main";
      },
      getExtensionStatuses() {
        return new Map([["caveman", CAVEMAN_STATUS_TEXT]]);
      },
      getAvailableProviderCount() {
        return 0;
      },
      onBranchChange() {
        return () => {
          /* noop */
        };
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
        preset: "default",
      },
      sessionStartTime: Date.now(),
      theme,
    });

    const occurrences = line.split(CAVEMAN_STATUS_TEXT).length - 1;
    expect(line).toContain(CAVEMAN_STATUS_TEXT);
    expect(occurrences).toBe(1);
  });

  it("renders caveman through extension statuses when dedicated segment is omitted", () => {
    const ctx = {
      model: {
        id: "test-model",
        name: "test-model",
        reasoning: false,
        contextWindow: 200_000,
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
          tokens: 25_000,
          contextWindow: 200_000,
          percent: 12.5,
        };
      },
    } as unknown as ExtensionContext;

    const footerData = {
      getGitBranch() {
        return "main";
      },
      getExtensionStatuses() {
        return new Map([["caveman", CAVEMAN_STATUS_TEXT]]);
      },
      getAvailableProviderCount() {
        return 0;
      },
      onBranchChange() {
        return () => {
          /* noop */
        };
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
        preset: "default",
        leftSegments: ["model", "path"],
        rightSegments: ["extension_statuses"],
      },
      sessionStartTime: Date.now(),
      theme,
    });

    expect(line).toContain(CAVEMAN_STATUS_TEXT);
  });

  it("right-aligns right-only configured segments", () => {
    const ctx = {
      model: {
        id: "test-model",
        name: "test-model",
        reasoning: false,
        contextWindow: 200_000,
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
          tokens: 25_000,
          contextWindow: 200_000,
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
        return () => {
          /* noop */
        };
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
