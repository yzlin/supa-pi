import { describe, expect, it } from "bun:test";

import { DEFAULT_RTK_CONFIG } from "./config";
import { createRtkRuntime } from "./runtime";
import { createRtkUserBashHandler } from "./user-bash";

describe("rtk user bash", () => {
  function createContext() {
    return {
      hasUI: true,
      ui: {
        notify() {},
      },
    } as any;
  }

  it("preserves !!cmd bypass", () => {
    const runtime = createRtkRuntime(DEFAULT_RTK_CONFIG);
    const handler = createRtkUserBashHandler(runtime);

    expect(
      handler(
        {
          type: "user_bash",
          command: "ls",
          excludeFromContext: true,
          cwd: process.cwd(),
        },
        createContext()
      )
    ).toBeUndefined();
  });

  it("does nothing when disabled", () => {
    const runtime = createRtkRuntime({
      ...DEFAULT_RTK_CONFIG,
      enabled: false,
    });
    const handler = createRtkUserBashHandler(runtime);

    expect(
      handler(
        {
          type: "user_bash",
          command: "ls",
          excludeFromContext: false,
          cwd: process.cwd(),
        },
        createContext()
      )
    ).toBeUndefined();
  });

  it("does nothing when RTK is unavailable and guarded", () => {
    const runtime = createRtkRuntime(DEFAULT_RTK_CONFIG);
    runtime.setStatus({
      rtkAvailable: false,
      lastCheckedAt: "now",
      lastError: "missing",
    });
    const handler = createRtkUserBashHandler(runtime);

    expect(
      handler(
        {
          type: "user_bash",
          command: "ls",
          excludeFromContext: false,
          cwd: process.cwd(),
        },
        createContext()
      )
    ).toBeUndefined();
  });

  it("rewrites !cmd before execution", async () => {
    const runtime = createRtkRuntime(DEFAULT_RTK_CONFIG);
    runtime.setStatus({
      rtkAvailable: true,
      lastCheckedAt: "now",
    });

    let executedCommand = "";
    const handler = createRtkUserBashHandler(runtime, {
      createLocalOperations: () => ({
        async exec(command) {
          executedCommand = command;
          return { exitCode: 0 };
        },
      }),
      resolveCommand: () => ({
        status: "rewritten",
        command: "exa",
        changed: true,
      }),
    });

    const result = handler(
      {
        type: "user_bash",
        command: "ls",
        excludeFromContext: false,
        cwd: process.cwd(),
      },
      createContext()
    );

    await result?.operations?.exec("ls", process.cwd(), {
      onData() {},
    } as any);

    expect(executedCommand).toBe("exa");
    expect(runtime.metrics.snapshot().userBashRewrites).toBe(1);
  });

  it("falls back to the original command on rewrite failure", async () => {
    const runtime = createRtkRuntime(DEFAULT_RTK_CONFIG);
    runtime.setStatus({
      rtkAvailable: true,
      lastCheckedAt: "now",
    });

    let executedCommand = "";
    const handler = createRtkUserBashHandler(runtime, {
      createLocalOperations: () => ({
        async exec(command) {
          executedCommand = command;
          return { exitCode: 0 };
        },
      }),
      resolveCommand: (command) => ({
        status: "fallback",
        command,
        changed: false,
      }),
    });

    const result = handler(
      {
        type: "user_bash",
        command: "ls",
        excludeFromContext: false,
        cwd: process.cwd(),
      },
      createContext()
    );

    await result?.operations?.exec("ls", process.cwd(), {
      onData() {},
    } as any);

    expect(executedCommand).toBe("ls");
    expect(runtime.metrics.snapshot().userBashRewrites).toBe(0);
  });
});
