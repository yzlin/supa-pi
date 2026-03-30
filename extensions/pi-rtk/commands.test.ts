import { describe, expect, it } from "bun:test";

import { registerRtkCommands } from "./commands";
import { DEFAULT_PI_RTK_CONFIG } from "./config";
import type { PiRtkRuntime } from "./types";

describe("pi-rtk commands", () => {
  function createRuntime(): PiRtkRuntime {
    return {
      getConfig: () => DEFAULT_PI_RTK_CONFIG,
      setConfig() {},
      getStatus: () => ({ rtkAvailable: true, lastCheckedAt: "now" }),
      setStatus() {},
      refreshRtkStatus: () => ({ rtkAvailable: true, lastCheckedAt: "now" }),
      resetSessionState() {},
      metrics: {
        recordRewriteAttempt() {},
        recordRewriteApplied() {},
        recordRewriteFallback() {},
        recordUserBashAttempt() {},
        recordUserBashRewrite() {},
        recordToolSavings() {},
        startCommand() {},
        completeCommand() {},
        reset() {},
        snapshot: () => ({
          rewriteAttempts: 0,
          rewritesApplied: 0,
          rewriteFallbacks: 0,
          userBashAttempts: 0,
          userBashRewrites: 0,
          toolSavingsByName: {},
          totalOriginalChars: 0,
          totalFinalChars: 0,
          totalSavedChars: 0,
          overallSavingsPercent: 0,
          rewriteRatePercent: 0,
          fallbackRatePercent: 0,
          userBashRewriteRatePercent: 0,
          summary: {
            totalCommands: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalSavedTokens: 0,
            avgSavingsPercent: 0,
            totalExecMs: 0,
            avgExecMs: 0,
          },
          tools: [],
          commandFamilies: [],
          commands: [],
          hasCommandData: false,
        }),
      },
    };
  }

  function registerHarness() {
    let commandOptions: any;

    registerRtkCommands(
      {
        registerCommand(_name, options) {
          commandOptions = options;
        },
      } as any,
      createRuntime()
    );

    return commandOptions;
  }

  it("registers argument completions for /rtk", () => {
    const command = registerHarness();

    expect(command.getArgumentCompletions).toBeFunction();
    expect(command.getArgumentCompletions("")).toEqual([
      {
        value: "show",
        label: "show",
        description: "Show config, runtime, and counters",
      },
      {
        value: "verify",
        label: "verify",
        description: "Refresh RTK availability",
      },
      {
        value: "stats",
        label: "stats",
        description: "Show rewrite stats",
      },
      {
        value: "clear-stats",
        label: "clear-stats",
        description: "Reset session counters",
      },
      {
        value: "reset",
        label: "reset",
        description: "Restore default config",
      },
      {
        value: "help",
        label: "help",
        description: "Show help",
      },
      {
        value: "enable",
        label: "enable",
        description: "Enable RTK rewrites",
      },
      {
        value: "disable",
        label: "disable",
        description: "Disable RTK rewrites",
      },
      {
        value: "mode",
        label: "mode",
        description: "Set rewrite mode",
      },
    ]);
  });

  it("suggests mode values after the mode subcommand", () => {
    const command = registerHarness();

    expect(command.getArgumentCompletions("mode ")).toEqual([
      {
        value: "mode rewrite",
        label: "rewrite",
        description: "Rewrite commands before execution",
      },
      {
        value: "mode suggest",
        label: "suggest",
        description: "Suggest-only mode",
      },
    ]);
  });

  it("filters nested mode suggestions by prefix", () => {
    const command = registerHarness();

    expect(command.getArgumentCompletions("mode s")).toEqual([
      {
        value: "mode suggest",
        label: "suggest",
        description: "Suggest-only mode",
      },
    ]);
    expect(command.getArgumentCompletions("mode z")).toBeNull();
    expect(command.getArgumentCompletions("zzz")).toBeNull();
  });

  it("stops suggesting once the mode argument is complete or over-typed", () => {
    const command = registerHarness();

    expect(command.getArgumentCompletions("mode rewrite ")).toBeNull();
    expect(command.getArgumentCompletions("mode rewrite extra")).toBeNull();
  });
});
