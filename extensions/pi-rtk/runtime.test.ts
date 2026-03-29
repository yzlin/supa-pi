import { describe, expect, it } from "bun:test";

import { DEFAULT_PI_RTK_CONFIG } from "./config";
import { createPiRtkRuntime } from "./runtime";

describe("pi-rtk runtime", () => {
  it("resets session metrics without mutating config", () => {
    const runtime = createPiRtkRuntime(DEFAULT_PI_RTK_CONFIG);

    runtime.metrics.recordRewriteAttempt();
    runtime.metrics.startCommand("1", "bash", "rtk ls", 0);
    runtime.metrics.completeCommand("1", {
      inputText: "x ".repeat(600),
      outputText: "x ".repeat(100),
      execMs: 12,
    });

    runtime.resetSessionState();

    expect(runtime.metrics.snapshot().hasCommandData).toBeFalse();
    expect(runtime.metrics.snapshot().rewriteAttempts).toBe(0);
    expect(runtime.getConfig()).toEqual(DEFAULT_PI_RTK_CONFIG);
  });
});
