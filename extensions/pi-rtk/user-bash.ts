import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import {
  type BashOperations,
  type ExtensionContext,
  getShellConfig,
  type UserBashEvent,
  type UserBashEventResult,
} from "@mariozechner/pi-coding-agent";

import { resolveRtkCommand } from "./rewrite";
import type { PiRtkRuntime } from "./types";

function killChild(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 250).unref();
}

export function createLocalBashOperations(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const { shell, args } = getShellConfig();

      return await new Promise<{ exitCode: number | null }>(
        (resolve, reject) => {
          const child = spawn(shell, [...args, command], {
            cwd,
            detached: true,
            env: env ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
          });

          let timedOut = false;
          let timeoutHandle: NodeJS.Timeout | undefined;

          if (timeout !== undefined && timeout > 0) {
            timeoutHandle = setTimeout(() => {
              timedOut = true;
              killChild(child);
            }, timeout * 1000);
          }

          child.stdout?.on("data", onData);
          child.stderr?.on("data", onData);

          child.on("error", (error) => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }

            signal?.removeEventListener("abort", onAbort);
            reject(error);
          });

          const onAbort = () => {
            killChild(child);
          };

          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          child.on("close", (exitCode) => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }

            signal?.removeEventListener("abort", onAbort);

            if (signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }

            if (timedOut) {
              reject(new Error(`timeout:${timeout}`));
              return;
            }

            resolve({ exitCode });
          });
        }
      );
    },
  };
}

export function createRtkUserBashHandler(
  runtime: PiRtkRuntime,
  deps?: {
    createLocalOperations?: () => BashOperations;
    resolveCommand?: typeof resolveRtkCommand;
  }
) {
  const local = (deps?.createLocalOperations ?? createLocalBashOperations)();

  return function handleUserBash(
    event: UserBashEvent,
    ctx: ExtensionContext
  ): UserBashEventResult | void {
    if (event.excludeFromContext) {
      return;
    }

    const config = runtime.getConfig();
    if (!config.enabled || config.mode !== "rewrite") {
      return;
    }

    let status = runtime.getStatus();
    if (!status.lastCheckedAt) {
      status = runtime.refreshRtkStatus();
    }

    if (!status.rtkAvailable && config.guardWhenRtkMissing) {
      return;
    }

    return {
      operations: {
        exec(command, cwd, options) {
          runtime.metrics.recordUserBashAttempt();
          const resolution = (deps?.resolveCommand ?? resolveRtkCommand)(
            command,
            {
              config: runtime.getConfig(),
              status: runtime.getStatus(),
              refreshStatus: () => runtime.refreshRtkStatus(),
            }
          );

          if (resolution.status === "rewritten") {
            runtime.metrics.recordUserBashRewrite();
            if (runtime.getConfig().showRewriteNotifications && ctx.hasUI) {
              ctx.ui.notify(
                `RTK rewrote !cmd: ${command} → ${resolution.command}`,
                "info"
              );
            }
          }

          return local.exec(resolution.command, cwd, options);
        },
      },
    };
  };
}
