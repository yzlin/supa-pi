import { describe, expect, it } from "bun:test";

import { createPiRtkMetricsStore } from "./metrics";

describe("pi-rtk metrics", () => {
  it("starts with a zero-state summary", () => {
    const metrics = createPiRtkMetricsStore().snapshot();

    expect(metrics.rewriteAttempts).toBe(0);
    expect(metrics.rewritesApplied).toBe(0);
    expect(metrics.rewriteFallbacks).toBe(0);
    expect(metrics.userBashAttempts).toBe(0);
    expect(metrics.userBashRewrites).toBe(0);
    expect(metrics.overallSavingsPercent).toBe(0);
    expect(metrics.toolSavingsByName.bash).toEqual({
      calls: 0,
      originalChars: 0,
      finalChars: 0,
    });
  });

  it("aggregates rewrite counters", () => {
    const store = createPiRtkMetricsStore();

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

  it("aggregates savings by tool", () => {
    const store = createPiRtkMetricsStore();

    store.recordToolSavings("bash", 100, 40);
    store.recordToolSavings("bash", 50, 25);
    store.recordToolSavings("read", 10, 10);

    expect(store.snapshot()).toMatchObject({
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
  });

  it("resets all counters", () => {
    const store = createPiRtkMetricsStore();

    store.recordRewriteAttempt();
    store.recordRewriteApplied();
    store.recordToolSavings("bash", 100, 20);
    store.reset();

    expect(store.snapshot()).toMatchObject({
      rewriteAttempts: 0,
      rewritesApplied: 0,
      totalOriginalChars: 0,
      totalFinalChars: 0,
      totalSavedChars: 0,
    });
  });
});
