import { describe, expect, it } from "bun:test";

import { DEFAULT_PI_RTK_CONFIG } from "./config";
import { createPiRtkMetricsStore } from "./metrics";
import { renderProgressBar, renderRtkStats } from "./stats";

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

describe("pi-rtk stats", () => {
  it("renders a friendly no-data state", () => {
    const output = stripAnsi(
      renderRtkStats(
        createPiRtkMetricsStore().snapshot(),
        DEFAULT_PI_RTK_CONFIG,
        120
      )
    );

    expect(output).toContain("RTK Token Savings (Session Scope)");
    expect(output).toContain("Overview");
    expect(output).toContain("No session savings yet.");
    expect(output).toContain("By Tool");
    expect(output).toContain("Top Command Families");
    expect(output).toContain("Raw Command Rows");
    expect(output).toContain("Impact");
    expect(output).not.toContain("By Command");
  });

  it("renders summary, tool rows, family rows, and raw commands", () => {
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

    store.startCommand("2", "bash", "rtk git diff HEAD~1", 0);
    store.completeCommand("2", {
      inputText: "a ".repeat(1600),
      outputText: "a ".repeat(400),
      execMs: 28,
    });

    store.startCommand("3", "read", "read", 0);
    store.completeCommand("3", {
      inputText: "b ".repeat(1200),
      outputText: "b ".repeat(700),
      execMs: 3,
    });

    const output = stripAnsi(
      renderRtkStats(store.snapshot(), DEFAULT_PI_RTK_CONFIG, 132)
    );

    expect(output).toContain("Total commands:");
    expect(output).toContain("Efficiency meter:");
    expect(output).toContain("Rewrite rate:");
    expect(output).toContain("By Tool");
    expect(output).toContain("Top Command Families");
    expect(output).toContain("Raw Command Rows");
    expect(output).toContain("bash");
    expect(output).toContain("git diff");
    expect(output).toContain("rtk git diff main");
    expect(output).toContain("Impact");

    const familyLine = output
      .split("\n")
      .find((line) => line.includes("1.") && line.includes("git diff"));

    expect(familyLine).toBeDefined();
    expect(familyLine).toContain("█");
  });

  it("shows hidden row count when raw commands exceed the table limit", () => {
    const store = createPiRtkMetricsStore();

    for (let index = 0; index < 11; index += 1) {
      const id = String(index + 1);
      store.startCommand(id, "bash", `rtk cmd ${id}`, 0);
      store.completeCommand(id, {
        inputText: "x ".repeat(200 + index * 10),
        outputText: "x ".repeat(20),
        execMs: 10 + index,
      });
    }

    const output = stripAnsi(
      renderRtkStats(store.snapshot(), DEFAULT_PI_RTK_CONFIG, 132)
    );

    expect(output).toContain("+ 1 more raw command row(s)");
  });

  it("renders off-state warnings", () => {
    const output = stripAnsi(
      renderRtkStats(createPiRtkMetricsStore().snapshot(), {
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
      })
    );

    expect(output).toContain("RTK is disabled");
    expect(output).toContain("Output compaction is off");
  });

  it("renders 100 percent bars", () => {
    expect(renderProgressBar(100)).toBe("████████████████████");
  });

  it("keeps impact inline on narrower widths", () => {
    const store = createPiRtkMetricsStore();
    store.startCommand("1", "bash", "rtk find src -name '*.ts'", 0);
    store.completeCommand("1", {
      inputText: "x ".repeat(800),
      outputText: "x ".repeat(100),
      execMs: 12,
    });

    const output = stripAnsi(
      renderRtkStats(store.snapshot(), DEFAULT_PI_RTK_CONFIG, 88)
    );
    const familyLine = output
      .split("\n")
      .find((line) => line.includes("1.") && line.includes("find"));

    expect(familyLine).toBeDefined();
    expect(familyLine).toContain("█");
  });
});
