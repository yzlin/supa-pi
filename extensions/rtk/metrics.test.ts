import { describe, expect, it } from "bun:test";

import { createRtkMetricsStore } from "./metrics";

describe("rtk metrics", () => {
  it("starts with a zero-state summary", () => {
    const metrics = createRtkMetricsStore().snapshot();

    expect(metrics.rewriteAttempts).toBe(0);
    expect(metrics.rewritesApplied).toBe(0);
    expect(metrics.rewriteFallbacks).toBe(0);
    expect(metrics.userBashAttempts).toBe(0);
    expect(metrics.userBashRewrites).toBe(0);
    expect(metrics.overallSavingsPercent).toBe(0);
    expect(metrics.summary).toEqual({
      totalCommands: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalSavedTokens: 0,
      avgSavingsPercent: 0,
      totalExecMs: 0,
      avgExecMs: 0,
    });
    expect(metrics.tools).toEqual([]);
    expect(metrics.commandFamilies).toEqual([]);
    expect(metrics.commands).toEqual([]);
    expect(metrics.toolSavingsByName.bash).toEqual({
      calls: 0,
      originalChars: 0,
      finalChars: 0,
    });
  });

  it("aggregates rewrite counters", () => {
    const store = createRtkMetricsStore();

    store.recordRewriteAttempt();
    store.recordRewriteAttempt();
    store.recordRewriteApplied();
    store.recordRewriteFallback();
    store.recordUserBashAttempt();
    store.recordUserBashAttempt();
    store.recordUserBashRewrite();

    expect(store.snapshot()).toMatchObject({
      rewriteAttempts: 2,
      rewritesApplied: 1,
      rewriteFallbacks: 1,
      rewriteRatePercent: 50,
      fallbackRatePercent: 50,
      userBashAttempts: 2,
      userBashRewrites: 1,
      userBashRewriteRatePercent: 50,
    });
  });

  it("aggregates savings by tool, family, and raw command", () => {
    const store = createRtkMetricsStore();

    store.recordToolSavings("bash", 100, 40);
    store.recordToolSavings("bash", 50, 25);
    store.recordToolSavings("read", 10, 10);

    store.startCommand("1", "bash", "rtk git diff main", 0);
    store.completeCommand("1", {
      inputText: "a ".repeat(1200),
      outputText: "a ".repeat(300),
      execMs: 47,
    });

    store.startCommand("2", "bash", "rtk git diff HEAD~1", 0);
    store.completeCommand("2", {
      inputText: "a ".repeat(800),
      outputText: "a ".repeat(200),
      execMs: 31,
    });

    store.startCommand("3", "read", "read", 0);
    store.completeCommand("3", {
      inputText: "b ".repeat(1000),
      outputText: "b ".repeat(700),
      execMs: 3,
    });

    const snapshot = store.snapshot();

    expect(snapshot).toMatchObject({
      totalOriginalChars: 160,
      totalFinalChars: 75,
      totalSavedChars: 85,
      overallSavingsPercent: 53,
      toolSavingsByName: {
        bash: {
          calls: 2,
          originalChars: 150,
          finalChars: 65,
        },
        read: {
          calls: 1,
          originalChars: 10,
          finalChars: 10,
        },
      },
    });

    expect(snapshot.summary.totalCommands).toBe(3);
    expect(snapshot.summary.totalSavedTokens).toBeGreaterThan(0);
    expect(snapshot.summary.avgExecMs).toBe(27);
    expect(snapshot.tools[0]?.label).toBe("bash");
    expect(snapshot.tools[0]?.count).toBe(2);
    expect(snapshot.commandFamilies[0]?.label).toBe("git diff");
    expect(snapshot.commandFamilies[0]?.count).toBe(2);
    expect(snapshot.commands[0]?.label).toBe("rtk git diff main");
    expect(snapshot.commands[0]?.savedTokens).toBeGreaterThan(
      snapshot.commands[1]?.savedTokens ?? 0
    );
  });

  it("keeps raw command rows sorted by saved tokens", () => {
    const store = createRtkMetricsStore();

    store.startCommand("1", "bash", "high", 0);
    store.completeCommand("1", {
      inputText: "x ".repeat(1800),
      outputText: "x ".repeat(200),
      execMs: 10,
    });

    store.startCommand("2", "bash", "low", 0);
    store.completeCommand("2", {
      inputText: "x ".repeat(800),
      outputText: "x ".repeat(500),
      execMs: 10,
    });

    expect(store.snapshot().commands.map((row) => row.label)).toEqual([
      "high",
      "low",
    ]);
  });

  it("normalizes user-bash command families", () => {
    const store = createRtkMetricsStore();

    store.startCommand("1", "user-bash", "rtk git status `main`", 0);
    store.completeCommand("1", {
      inputText: "x ".repeat(900),
      outputText: "x ".repeat(100),
      execMs: 14,
    });

    expect(store.snapshot().commandFamilies[0]?.label).toBe("git status");
  });

  it("resets all counters and session rows", () => {
    const store = createRtkMetricsStore();

    store.recordRewriteAttempt();
    store.recordRewriteApplied();
    store.recordToolSavings("bash", 100, 20);
    store.startCommand("1", "bash", "rtk ls", 0);
    store.completeCommand("1", {
      inputText: "x ".repeat(500),
      outputText: "x ".repeat(100),
      execMs: 12,
    });
    store.reset();

    expect(store.snapshot()).toMatchObject({
      rewriteAttempts: 0,
      rewritesApplied: 0,
      totalOriginalChars: 0,
      totalFinalChars: 0,
      totalSavedChars: 0,
      hasCommandData: false,
    });
    expect(store.snapshot().tools).toEqual([]);
    expect(store.snapshot().commandFamilies).toEqual([]);
    expect(store.snapshot().commands).toEqual([]);
  });
});
