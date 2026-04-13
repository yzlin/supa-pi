import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

import type {
  RtkConfig,
  RtkRewriteResolution,
  RtkRewriteResult,
  RtkRunner,
  RtkRunnerResult,
  RtkRuntimeStatus,
} from "./types";

export const DEFAULT_RTK_REWRITE_TIMEOUT_MS = 3_000;
export const DEFAULT_RTK_VERIFY_TIMEOUT_MS = 1_000;

let cachedRtkBinaryPath: string | undefined;

function formatCommandFailure(
  result: RtkRunnerResult,
  timeoutMs: number,
  fallback: string
): string {
  if (result.error) {
    return result.error;
  }

  if (result.exitCode === null) {
    return `RTK command timed out after ${timeoutMs}ms`;
  }

  const stderr = result.stderr.trim();
  return stderr || fallback;
}

export const defaultRtkRunner: RtkRunner = (
  file,
  args,
  timeoutMs
): RtkRunnerResult => {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: timeoutMs,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
    error: result.error?.message,
  };
};

function resolveBinaryPathError(message: string): Error {
  return new Error(message || "Could not resolve RTK binary path");
}

function defaultResolveRtkBinaryPath(
  runner: RtkRunner,
  timeoutMs: number
): string {
  if (cachedRtkBinaryPath) {
    return cachedRtkBinaryPath;
  }

  const locator = process.platform === "win32" ? "where" : "which";
  const result = runner(locator, ["rtk"], timeoutMs);
  if (result.error || result.exitCode !== 0) {
    throw resolveBinaryPathError(
      formatCommandFailure(result, timeoutMs, "RTK is unavailable")
    );
  }

  const resolvedPath = result.stdout.trim();
  if (!resolvedPath || !isAbsolute(resolvedPath)) {
    throw resolveBinaryPathError("Resolved RTK path is invalid");
  }

  cachedRtkBinaryPath = resolvedPath;
  return resolvedPath;
}

export function clearRtkBinaryPathCache(): void {
  cachedRtkBinaryPath = undefined;
}

function resolveBinaryPath(
  runner: RtkRunner,
  timeoutMs: number,
  customResolver?: (runner: RtkRunner, timeoutMs: number) => string
): string {
  return (customResolver ?? defaultResolveRtkBinaryPath)(runner, timeoutMs);
}

export function checkRtkAvailability(options?: {
  runner?: RtkRunner;
  timeoutMs?: number;
  resolveBinaryPath?: (runner: RtkRunner, timeoutMs: number) => string;
}): RtkRuntimeStatus {
  const runner = options?.runner ?? defaultRtkRunner;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RTK_VERIFY_TIMEOUT_MS;
  const lastCheckedAt = new Date().toISOString();

  try {
    const binaryPath = resolveBinaryPath(
      runner,
      timeoutMs,
      options?.resolveBinaryPath
    );
    const result = runner(binaryPath, ["--help"], timeoutMs);

    if (result.error || result.exitCode !== 0) {
      return {
        rtkAvailable: false,
        lastCheckedAt,
        lastError: formatCommandFailure(
          result,
          timeoutMs,
          "RTK is unavailable"
        ),
      };
    }

    return {
      rtkAvailable: true,
      lastCheckedAt,
    };
  } catch (error) {
    return {
      rtkAvailable: false,
      lastCheckedAt,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function rewriteCommandWithRtk(
  command: string,
  options?: {
    runner?: RtkRunner;
    timeoutMs?: number;
    resolveBinaryPath?: (runner: RtkRunner, timeoutMs: number) => string;
  }
): RtkRewriteResult {
  const runner = options?.runner ?? defaultRtkRunner;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RTK_REWRITE_TIMEOUT_MS;
  const binaryPath = resolveBinaryPath(
    runner,
    timeoutMs,
    options?.resolveBinaryPath
  );
  const result = runner(binaryPath, ["rewrite", command], timeoutMs);

  if (result.error || result.exitCode !== 0) {
    throw new Error(
      formatCommandFailure(result, timeoutMs, "RTK rewrite failed")
    );
  }

  const rewritten = result.stdout.trim();
  if (!rewritten) {
    throw new Error("RTK rewrite returned empty output");
  }

  return {
    rewritten,
    changed: rewritten !== command,
  };
}

export function resolveRtkCommand(
  command: string,
  options: {
    config: RtkConfig;
    status: RtkRuntimeStatus;
    refreshStatus?: () => RtkRuntimeStatus;
    rewrite?: typeof rewriteCommandWithRtk;
  }
): RtkRewriteResolution {
  if (!options.config.enabled) {
    return {
      status: "disabled",
      command,
      changed: false,
    };
  }

  if (options.config.mode === "suggest") {
    return {
      status: "suggest",
      command,
      changed: false,
    };
  }

  let status = options.status;
  if (!status.lastCheckedAt && options.refreshStatus) {
    status = options.refreshStatus();
  }

  if (!status.rtkAvailable && options.config.guardWhenRtkMissing) {
    return {
      status: "guarded",
      command,
      changed: false,
      reason: status.lastError ?? "RTK is unavailable",
    };
  }

  try {
    const rewrite = (options.rewrite ?? rewriteCommandWithRtk)(command);
    return {
      status: rewrite.changed ? "rewritten" : "unchanged",
      command: rewrite.rewritten,
      changed: rewrite.changed,
    };
  } catch (error) {
    return {
      status: "fallback",
      command,
      changed: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
