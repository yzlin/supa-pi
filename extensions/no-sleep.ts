/**
 * Copied from the no-sleep extension in mitsuhiko/agent-stuff.
 * Original author: mitsuhiko.
 * Source: https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/no-sleep.ts
 * License: Apache-2.0.
 * Local changes: formatted and lint-adjusted for this repository.
 */

/**
 * Prevent macOS from sleeping while pi's agent is running.
 *
 * Uses caffeinate(8). No footer/status UI is rendered, and no chat
 * notifications are emitted for routine caffeination state changes.
 * Error/warning notifications are still surfaced.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DISABLED_VALUE_REGEX = /^(0|false|no|off)$/i;
const SESSION_SCOPE_REGEX = /^session$/i;
const MACOS = process.platform === "darwin";

type Scope = "agent" | "session";
type Level = "info" | "warning" | "error";

let caffeinate: ChildProcess | undefined;
let enabled = readBooleanEnv("PI_NO_SLEEP", true);
let scope: Scope = readScopeEnv();
let agentActive = false;
let lastError: string | undefined;

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  return !DISABLED_VALUE_REGEX.test(value);
}

function readScopeEnv(): Scope {
  return SESSION_SCOPE_REGEX.test(process.env.PI_NO_SLEEP_SCOPE ?? "")
    ? "session"
    : "agent";
}

function caffeinateArgs(): string[] {
  const args = ["-i", "-s"];

  // By default, allow the display to sleep. Set PI_NO_SLEEP_DISPLAY=1 to keep
  // the screen awake too.
  if (readBooleanEnv("PI_NO_SLEEP_DISPLAY", false)) {
    args.push("-d");
  }

  // Tie the assertion to the pi process so a hard crash won't leave caffeinate
  // running forever.
  args.push("-w", String(process.pid));
  return args;
}

function notify(
  ctx: ExtensionContext | undefined,
  message: string,
  level: Level = "info"
): void {
  if (ctx?.hasUI) {
    ctx.ui.notify(message, level);
  }
}

function start(ctx?: ExtensionContext): void {
  if (!(enabled && MACOS) || caffeinate) {
    return;
  }

  lastError = undefined;
  const child = spawn("caffeinate", caffeinateArgs(), { stdio: "ignore" });
  child.unref();
  caffeinate = child;

  child.once("error", (error) => {
    if (caffeinate !== child) {
      return;
    }
    caffeinate = undefined;
    lastError = error.message;
    notify(ctx, `No Sleep: failed to caffeinate: ${error.message}`, "error");
  });

  child.once("exit", (code, signal) => {
    if (caffeinate !== child) {
      return;
    }
    caffeinate = undefined;

    if (code && code !== 0) {
      lastError = `caffeinate exited with code ${code}`;
      notify(
        ctx,
        `No Sleep: caffeinate stopped unexpectedly (${lastError}).`,
        "warning"
      );
    } else if (signal) {
      lastError = `caffeinate exited after signal ${signal}`;
      notify(
        ctx,
        `No Sleep: caffeinate stopped unexpectedly (${lastError}).`,
        "warning"
      );
    }
  });
}

function stop(_ctx?: ExtensionContext): void {
  const child = caffeinate;
  caffeinate = undefined;

  if (!child) {
    return;
  }

  if (child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 1000);
    timer.unref?.();
  }
}

function reconcile(ctx?: ExtensionContext): void {
  if (!enabled) {
    stop(ctx);
    return;
  }

  if (scope === "session" || agentActive) {
    start(ctx);
  } else {
    stop(ctx);
  }
}

function describeState(): string {
  if (!MACOS) {
    return "No Sleep is inactive: caffeinate is only available on macOS.";
  }

  const state = caffeinate
    ? `active (pid ${caffeinate.pid ?? "unknown"})`
    : "idle";
  const display = readBooleanEnv("PI_NO_SLEEP_DISPLAY", false) ? "yes" : "no";
  return [
    `No Sleep is ${enabled ? "enabled" : "disabled"}.`,
    `scope: ${scope}`,
    `state: ${state}`,
    `keeps display awake: ${display}`,
    lastError ? `last error: ${lastError}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export default function noSleepExtension(pi: ExtensionAPI) {
  const cleanupOnProcessExit = () => {
    stop(undefined);
  };
  process.once("exit", cleanupOnProcessExit);

  pi.on("session_start", (_event, ctx) => {
    agentActive = false;
    reconcile(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    agentActive = true;
    reconcile(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    agentActive = false;
    reconcile(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    agentActive = false;
    stop(ctx);
    process.off("exit", cleanupOnProcessExit);
  });

  pi.registerCommand("no-sleep", {
    description: "Show or change macOS sleep-prevention status",
    handler: (args, ctx) => {
      const command = args.trim().toLowerCase();

      if (command === "on" || command === "enable") {
        enabled = true;
        reconcile(ctx);
      } else if (command === "off" || command === "disable") {
        enabled = false;
        reconcile(ctx);
      } else if (command === "toggle") {
        enabled = !enabled;
        reconcile(ctx);
      } else if (command === "agent") {
        scope = "agent";
        reconcile(ctx);
      } else if (command === "session") {
        scope = "session";
        reconcile(ctx);
      } else if (command && command !== "status") {
        notify(
          ctx,
          "Usage: /no-sleep [status|on|off|toggle|agent|session]",
          "warning"
        );
        return;
      }

      notify(ctx, describeState(), lastError ? "warning" : "info");
    },
  });
}
