import { describe, expect, it } from "bun:test";

import { DEFAULT_PI_RTK_CONFIG } from "./config";
import { createPiRtkMetricsStore } from "./metrics";
import { renderProgressBar, renderRtkStats } from "./stats";

describe("pi-rtk stats", () => {
  it("renders a friendly no-data state", () => {
    const output = renderRtkStats(
      createPiRtkMetricsStore().snapshot(),
      DEFAULT_PI_RTK_CONFIG
    );

    expect(output).toContain("No data yet.");
    expect(output).toContain("overall savings");
    expect(output).toContain("(no data)");
  });

  it("renders partial values", () => {
    const store = createPiRtkMetricsStore();
    store.recordRewriteAttempt();
    store.recordRewriteAttempt();
    store.recordRewriteApplied();
    store.recordRewriteFallback();
    store.recordUserBashAttempt();
    store.recordUserBashRewrite();
    store.recordToolSavings("bash", 100, 40);

    const output = renderRtkStats(store.snapshot(), DEFAULT_PI_RTK_CONFIG);

    expect(output).toContain("rewrites");
    expect(output).toContain("50%");
    expect(output).toContain("user !cmd");
    expect(output).toContain("1/1");
    expect(output).toContain("overall savings");
    expect(output).toContain("60%");
    expect(output).toContain("100→40 chars");
  });

  it("renders 100 percent bars", () => {
    expect(renderProgressBar(100)).toBe("██████████");
  });

  it("renders off-state rows", () => {
    const output = renderRtkStats(createPiRtkMetricsStore().snapshot(), {
      ...DEFAULT_PI_RTK_CONFIG,
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        enabled: false,
        compactBash: false,
        compactGrep: false,
        compactRead: false,
        trackSavings: false,
      },
    });

    expect(output).toContain("bash savings");
    expect(output).toContain("grep savings");
    expect(output).toContain("read savings");
    expect(output).toContain("off");
  });

  it("keeps progress bars aligned", () => {
    const output = renderRtkStats(
      createPiRtkMetricsStore().snapshot(),
      DEFAULT_PI_RTK_CONFIG
    );
    const lines = output
      .split("\n")
      .filter((line) => line.includes("█") || line.includes("░"));

    const barStarts = new Set(lines.map((line) => line.search(/[█░]/)));
    expect(barStarts.size).toBe(1);
  });
});
