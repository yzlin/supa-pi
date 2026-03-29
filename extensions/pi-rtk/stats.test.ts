import { describe, expect, it } from "bun:test";

import { DEFAULT_PI_RTK_CONFIG } from "./config";
import { createPiRtkMetricsStore } from "./metrics";
import { renderProgressBar, renderRtkStats } from "./stats";

describe("pi-rtk stats", () => {
  it("renders a friendly no-data state", () => {
    const output = renderRtkStats(
      createPiRtkMetricsStore().snapshot(),
      DEFAULT_PI_RTK_CONFIG,
      120
    );

    expect(output).toContain("RTK Token Savings (Session Scope)");
    expect(output).toContain("No session savings yet.");
    expect(output).toContain("By Command");
    expect(output).toContain("Impact chart");
  });

  it("renders summary, table, and impact rows", () => {
    const store = createPiRtkMetricsStore();
    store.recordRewriteAttempt();
    store.recordRewriteAttempt();
    store.recordRewriteApplied();
    store.recordRewriteFallback();
    store.recordUserBashAttempt();
    store.recordUserBashRewrite();

    store.startCommand("1", "bash", "rtk git diff main", 0);
    store.completeCommand("1", {
      inputText: "a ".repeat(2000),
      outputText: "a ".repeat(200),
      execMs: 47,
    });

    store.startCommand("2", "read", "read", 0);
    store.completeCommand("2", {
      inputText: "b ".repeat(1200),
      outputText: "b ".repeat(700),
      execMs: 3,
    });

    const output = renderRtkStats(store.snapshot(), DEFAULT_PI_RTK_CONFIG, 132);

    expect(output).toContain("Total commands:");
    expect(output).toContain("Efficiency meter:");
    expect(output).toContain("Rewrite rate:");
    expect(output).toContain("By Command");
    expect(output).toContain("rtk git diff main");
    expect(output).toContain("Impact chart");
    expect(output).toContain("1.  rtk git diff main");
  });

  it("renders off-state warnings", () => {
    const output = renderRtkStats(createPiRtkMetricsStore().snapshot(), {
      ...DEFAULT_PI_RTK_CONFIG,
      enabled: false,
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        enabled: false,
        compactBash: false,
        compactGrep: false,
        compactRead: false,
        trackSavings: false,
      },
    });

    expect(output).toContain("RTK is disabled");
    expect(output).toContain("Output compaction is off");
  });

  it("renders 100 percent bars", () => {
    expect(renderProgressBar(100)).toBe("████████████████████");
  });

  it("uses stacked layout on narrower widths", () => {
    const store = createPiRtkMetricsStore();
    store.startCommand("1", "bash", "rtk find", 0);
    store.completeCommand("1", {
      inputText: "x ".repeat(800),
      outputText: "x ".repeat(100),
      execMs: 12,
    });

    const output = renderRtkStats(store.snapshot(), DEFAULT_PI_RTK_CONFIG, 88);
    const byCommandIndex = output.indexOf("By Command");
    const impactIndex = output.indexOf("Impact chart");

    expect(byCommandIndex).toBeGreaterThan(-1);
    expect(impactIndex).toBeGreaterThan(byCommandIndex);
  });
});
