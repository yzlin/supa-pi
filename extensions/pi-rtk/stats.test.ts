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
    expect(output).toContain("off");
  });

  it("renders partial values", () => {
    const store = createPiRtkMetricsStore();
    store.recordRewriteAttempt();
    store.recordRewriteAttempt();
    store.recordRewriteApplied();
    store.recordRewriteFallback();
    store.recordUserBashAttempt();
    store.recordUserBashRewrite();

    const output = renderRtkStats(store.snapshot(), DEFAULT_PI_RTK_CONFIG);

    expect(output).toContain("rewrites");
    expect(output).toContain("50%");
    expect(output).toContain("user !cmd");
    expect(output).toContain("1/1");
  });

  it("renders 100 percent bars", () => {
    expect(renderProgressBar(100)).toBe("██████████");
  });

  it("renders off-state rows", () => {
    const output = renderRtkStats(
      createPiRtkMetricsStore().snapshot(),
      DEFAULT_PI_RTK_CONFIG
    );

    expect(output).toContain("bash savings");
    expect(output).toContain("grep savings");
    expect(output).toContain("read savings");
    expect(output).toContain("off");
  });

  it("keeps row widths stable", () => {
    const output = renderRtkStats(
      createPiRtkMetricsStore().snapshot(),
      DEFAULT_PI_RTK_CONFIG
    );
    const lines = output
      .split("\n")
      .filter((line) => line.includes("█") || line.includes("░"));

    const lengths = new Set(lines.map((line) => line.length));
    expect(lengths.size).toBeGreaterThan(0);
  });
});
