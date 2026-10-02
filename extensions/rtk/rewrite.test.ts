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

  it.each([0, 3])("rewrites successfully on exit %i", (exitCode) => {
    const result = rewriteCommandWithRtk("ls", {
      runner: createRunner({
        stdout: "  exa\n",
        stderr: "",
        exitCode,
      }),
      resolveBinaryPath: () => "/usr/bin/rtk",
    });

    expect(result).toEqual({
      rewritten: "exa",
      changed: true,
    });
  });

  it.each([1, 2])("passes through unchanged on exit %i", (exitCode) => {
    const result = rewriteCommandWithRtk("ls", {
      runner: createRunner({
        stdout: "",
        stderr: "",
        exitCode,
      }),
      resolveBinaryPath: () => "/usr/bin/rtk",
    });

    expect(result).toEqual({
      rewritten: "ls",
      changed: false,
    });
  });

  it("fails on unexpected exit codes", () => {
    expect(() =>
      rewriteCommandWithRtk("ls", {
        runner: createRunner({
          stdout: "",
          stderr: "boom",
          exitCode: 4,
        }),
        resolveBinaryPath: () => "/usr/bin/rtk",
      }),
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
      }),
    ).toThrow("timed out");
  });

  it.each([0, 3])("fails on empty output on exit %i", (exitCode) => {
    expect(() =>
      rewriteCommandWithRtk("ls", {
        runner: createRunner({
          stdout: "   ",
          stderr: "",
          exitCode,
        }),
        resolveBinaryPath: () => "/usr/bin/rtk",
      }),
    ).toThrow("empty output");
  });

  it.each([0, 1, 2, 3])(
    "fails on spawn errors even with exit %i",
    (exitCode) => {
      expect(() =>
        rewriteCommandWithRtk("ls", {
          runner: createRunner({
            stdout: "rtk ls",
            stderr: "",
            exitCode,
            error: "spawn failed",
          }),
          resolveBinaryPath: () => "/usr/bin/rtk",
        }),
      ).toThrow("spawn failed");
    },
  );

  it.each([0, 3])("handles unchanged output cleanly on exit %i", (exitCode) => {
    const result = rewriteCommandWithRtk("ls", {
      runner: createRunner({
        stdout: "ls\n",
        stderr: "",
        exitCode,
      }),
      resolveBinaryPath: () => "/usr/bin/rtk",
    });

    expect(result).toEqual({
      rewritten: "ls",
      changed: false,
    });
  });

  it.each([
    {
      exitCode: 3,
      stdout: "rtk git status\n",
      status: "rewritten",
      changed: true,
    },
    { exitCode: 1, stdout: "", status: "unchanged", changed: false },
    { exitCode: 2, stdout: "", status: "unchanged", changed: false },
    { exitCode: 4, stdout: "", status: "fallback", changed: false },
    { exitCode: null, stdout: "", status: "fallback", changed: false },
  ])(
    "resolves exit $exitCode as $status",
    ({ exitCode, stdout, status, changed }) => {
      const result = resolveRtkCommand("git status", {
        config: DEFAULT_RTK_CONFIG,
        status: { rtkAvailable: true, lastCheckedAt: "now" },
        rewrite: (command) =>
          rewriteCommandWithRtk(command, {
            runner: createRunner({ stdout, stderr: "", exitCode }),
            resolveBinaryPath: () => "/usr/bin/rtk",
          }),
      });

      expect(result.status).toBe(status);
      expect(result.command).toBe(changed ? "rtk git status" : "git status");
      expect(result.changed).toBe(changed);
      if (status === "fallback") {
        expect(result.reason).toBe(
          exitCode === null
            ? "RTK command timed out after 3000ms"
            : "RTK rewrite failed",
        );
      }
    },
  );

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
