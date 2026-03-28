import { describe, expect, it } from "bun:test";

import { createRtkToolResultHandler } from "./output-compaction";
import { DEFAULT_PI_RTK_CONFIG } from "./config";
import { createPiRtkMetricsStore } from "./metrics";
import type { PiRtkConfig, PiRtkRuntime } from "./types";

function createRuntime(config?: PiRtkConfig): PiRtkRuntime {
  const metrics = createPiRtkMetricsStore();
  let currentConfig = structuredClone(config ?? DEFAULT_PI_RTK_CONFIG);

  return {
    getConfig: () => structuredClone(currentConfig),
    setConfig(nextConfig) {
      currentConfig = structuredClone(nextConfig);
    },
    getStatus: () => ({ rtkAvailable: true }),
    setStatus() {},
    refreshRtkStatus: () => ({ rtkAvailable: true }),
    resetSessionState() {
      metrics.reset();
    },
    metrics,
  };
}

describe("pi-rtk output compaction", () => {
  it("compacts bash output from the tail and records savings", async () => {
    const runtime = createRuntime({
      ...DEFAULT_PI_RTK_CONFIG,
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        enabled: true,
        compactBash: true,
        maxLines: 2,
        maxChars: 1_000,
        trackSavings: true,
      },
    });

    const handler = createRtkToolResultHandler(runtime);
    const result = await handler({
      type: "tool_result",
      toolCallId: "1",
      toolName: "bash",
      input: { command: "seq 1 4" },
      content: [{ type: "text", text: "1\n2\n3\n4" }],
      details: undefined,
      isError: false,
    } as any);

    expect(result).toEqual({
      content: [{ type: "text", text: "3\n4" }],
    });
    expect(runtime.metrics.snapshot()).toMatchObject({
      totalOriginalChars: 7,
      totalFinalChars: 3,
      totalSavedChars: 4,
      toolSavingsByName: {
        bash: {
          calls: 1,
          originalChars: 7,
          finalChars: 3,
        },
      },
    });
  });

  it("compacts read output from the head", async () => {
    const runtime = createRuntime({
      ...DEFAULT_PI_RTK_CONFIG,
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        enabled: true,
        compactRead: true,
        maxLines: 2,
        maxChars: 1_000,
      },
    });

    const handler = createRtkToolResultHandler(runtime);
    const result = await handler({
      type: "tool_result",
      toolCallId: "1",
      toolName: "read",
      input: { path: "a.txt" },
      content: [{ type: "text", text: "1\n2\n3\n4" }],
      details: undefined,
      isError: false,
    } as any);

    expect(result).toEqual({
      content: [{ type: "text", text: "1\n2" }],
    });
  });

  it("compacts grep output from the head", async () => {
    const runtime = createRuntime({
      ...DEFAULT_PI_RTK_CONFIG,
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        enabled: true,
        compactGrep: true,
        maxLines: 2,
        maxChars: 1_000,
      },
    });

    const handler = createRtkToolResultHandler(runtime);
    const result = await handler({
      type: "tool_result",
      toolCallId: "1",
      toolName: "grep",
      input: { pattern: "x" },
      content: [{ type: "text", text: "1\n2\n3\n4" }],
      details: undefined,
      isError: false,
    } as any);

    expect(result).toEqual({
      content: [{ type: "text", text: "1\n2" }],
    });
  });

  it("skips compaction when the master switch is off", async () => {
    const runtime = createRuntime({
      ...DEFAULT_PI_RTK_CONFIG,
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        enabled: false,
        compactGrep: true,
        maxLines: 2,
        maxChars: 1_000,
      },
    });

    const handler = createRtkToolResultHandler(runtime);
    const result = await handler({
      type: "tool_result",
      toolCallId: "1",
      toolName: "grep",
      input: { pattern: "x" },
      content: [{ type: "text", text: "1\n2\n3\n4" }],
      details: undefined,
      isError: false,
    } as any);

    expect(result).toBeUndefined();
    expect(runtime.metrics.snapshot().toolSavingsByName.grep?.calls ?? 0).toBe(0);
  });

  it("skips compaction when the tool-specific flag is off", async () => {
    const runtime = createRuntime({
      ...DEFAULT_PI_RTK_CONFIG,
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        enabled: true,
        compactGrep: false,
        maxLines: 2,
        maxChars: 1_000,
      },
    });

    const handler = createRtkToolResultHandler(runtime);
    const result = await handler({
      type: "tool_result",
      toolCallId: "1",
      toolName: "grep",
      input: { pattern: "x" },
      content: [{ type: "text", text: "1\n2\n3\n4" }],
      details: undefined,
      isError: false,
    } as any);

    expect(result).toBeUndefined();
    expect(runtime.metrics.snapshot().toolSavingsByName.grep?.calls ?? 0).toBe(0);
  });

  it("does not record savings for no-op compaction", async () => {
    const runtime = createRuntime({
      ...DEFAULT_PI_RTK_CONFIG,
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        enabled: true,
        compactRead: true,
        maxLines: 10,
        maxChars: 1_000,
        trackSavings: true,
      },
    });

    const handler = createRtkToolResultHandler(runtime);
    const result = await handler({
      type: "tool_result",
      toolCallId: "1",
      toolName: "read",
      input: { path: "a.txt" },
      content: [{ type: "text", text: "1\n2" }],
      details: undefined,
      isError: false,
    } as any);

    expect(result).toBeUndefined();
    expect(runtime.metrics.snapshot().toolSavingsByName.read?.calls ?? 0).toBe(0);
  });

  it("treats maxChars as characters rather than bytes", async () => {
    const runtime = createRuntime({
      ...DEFAULT_PI_RTK_CONFIG,
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        enabled: true,
        compactRead: true,
        maxLines: 10,
        maxChars: 3,
      },
    });

    const handler = createRtkToolResultHandler(runtime);
    const result = await handler({
      type: "tool_result",
      toolCallId: "1",
      toolName: "read",
      input: { path: "a.txt" },
      content: [{ type: "text", text: "你好世界" }],
      details: undefined,
      isError: false,
    } as any);

    expect(result).toEqual({
      content: [{ type: "text", text: "你好…" }],
    });
  });

  it("applies maxChars after maxLines", async () => {
    const runtime = createRuntime({
      ...DEFAULT_PI_RTK_CONFIG,
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        enabled: true,
        compactRead: true,
        maxLines: 2,
        maxChars: 5,
      },
    });

    const handler = createRtkToolResultHandler(runtime);
    const result = await handler({
      type: "tool_result",
      toolCallId: "1",
      toolName: "read",
      input: { path: "a.txt" },
      content: [{ type: "text", text: "1234\n5678\n9999" }],
      details: undefined,
      isError: false,
    } as any);

    expect(result).toEqual({
      content: [{ type: "text", text: "1234…" }],
    });
  });

  it("skips non-text read payloads", async () => {
    const runtime = createRuntime({
      ...DEFAULT_PI_RTK_CONFIG,
      outputCompaction: {
        ...DEFAULT_PI_RTK_CONFIG.outputCompaction,
        enabled: true,
        compactRead: true,
        maxLines: 2,
        maxChars: 1_000,
      },
    });

    const handler = createRtkToolResultHandler(runtime);
    const result = await handler({
      type: "tool_result",
      toolCallId: "1",
      toolName: "read",
      input: { path: "a.png" },
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
      details: undefined,
      isError: false,
    } as any);

    expect(result).toBeUndefined();
  });
});
