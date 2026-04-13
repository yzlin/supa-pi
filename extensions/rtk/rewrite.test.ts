import { afterEach, describe, expect, it } from "bun:test";

import { DEFAULT_RTK_CONFIG } from "./config";
import {
  checkRtkAvailability,
  clearRtkBinaryPathCache,
  resolveRtkCommand,
  rewriteCommandWithRtk,
} from "./rewrite";
import type { RtkRunner } from "./types";

function createRunner(result: ReturnType<RtkRunner>): RtkRunner {
  return () => result;
}

describe("rtk rewrite", () => {
  afterEach(() => {
    clearRtkBinaryPathCache();
  });

  it("rewrites successfully", () => {
    const result = rewriteCommandWithRtk("ls", {
      runner: createRunner({
        stdout: "exa\n",
        stderr: "",
        exitCode: 0,
      }),
      resolveBinaryPath: () => "/usr/bin/rtk",
    });

    expect(result).toEqual({
      rewritten: "exa",
      changed: true,
    });
  });

  it("fails on non-zero exit", () => {
    expect(() =>
      rewriteCommandWithRtk("ls", {
        runner: createRunner({
          stdout: "",
          stderr: "boom",
          exitCode: 1,
        }),
        resolveBinaryPath: () => "/usr/bin/rtk",
      })
    ).toThrow("boom");
  });

  it("fails on timeout", () => {
    expect(() =>
      rewriteCommandWithRtk("ls", {
        runner: createRunner({
          stdout: "",
          stderr: "",
          exitCode: null,
        }),
        timeoutMs: 10,
        resolveBinaryPath: () => "/usr/bin/rtk",
      })
    ).toThrow("timed out");
  });

  it("fails on empty output", () => {
    expect(() =>
      rewriteCommandWithRtk("ls", {
        runner: createRunner({
          stdout: "   ",
          stderr: "",
          exitCode: 0,
        }),
        resolveBinaryPath: () => "/usr/bin/rtk",
      })
    ).toThrow("empty output");
  });

  it("handles unchanged output cleanly", () => {
    const result = rewriteCommandWithRtk("ls", {
      runner: createRunner({
        stdout: "ls\n",
        stderr: "",
        exitCode: 0,
      }),
      resolveBinaryPath: () => "/usr/bin/rtk",
    });

    expect(result).toEqual({
      rewritten: "ls",
      changed: false,
    });
  });

  it("does not mutate commands in suggest mode", () => {
    const result = resolveRtkCommand("ls", {
      config: {
        ...DEFAULT_RTK_CONFIG,
        mode: "suggest",
      },
      status: {
        rtkAvailable: true,
        lastCheckedAt: "now",
      },
    });

    expect(result).toEqual({
      status: "suggest",
      command: "ls",
      changed: false,
    });
  });

  it("reports availability failures", () => {
    const result = checkRtkAvailability({
      runner: createRunner({
        stdout: "",
        stderr: "missing",
        exitCode: 1,
      }),
      resolveBinaryPath: () => "/usr/bin/rtk",
    });

    expect(result.rtkAvailable).toBe(false);
    expect(result.lastError).toContain("missing");
  });
});
