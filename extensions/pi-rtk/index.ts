import {
  createBashTool,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

import { registerRtkCommands } from "./commands";
import { loadPiRtkConfig } from "./config";
import {
  createRtkToolExecutionStartHandler,
  createRtkToolResultHandler,
} from "./output-compaction";
import { clearRtkBinaryPathCache, resolveRtkCommand } from "./rewrite";
import { createPiRtkRuntime } from "./runtime";
import { createRtkUserBashHandler } from "./user-bash";

function loadRuntimeState(
  cwd: string,
  runtime: ReturnType<typeof createPiRtkRuntime>
): void {
  clearRtkBinaryPathCache();
  runtime.setConfig(loadPiRtkConfig(cwd));
  runtime.resetSessionState();
  runtime.refreshRtkStatus();
}

function registerSessionHandler(
  pi: ExtensionAPI,
  eventName: "session_start" | "session_switch",
  runtime: ReturnType<typeof createPiRtkRuntime>,
  updateBashTool: (cwd: string) => void
): void {
  pi.on(eventName, async (_event, ctx) => {
    loadRuntimeState(ctx.cwd, runtime);
    updateBashTool(ctx.cwd);
  });
}

export default function piRtkExtension(pi: ExtensionAPI): void {
  const runtime = createPiRtkRuntime(loadPiRtkConfig(process.cwd()));
  let bashTool = createBashTool(process.cwd());

  registerSessionHandler(pi, "session_start", runtime, (cwd) => {
    bashTool = createBashTool(cwd);
  });

  registerSessionHandler(pi, "session_switch", runtime, (cwd) => {
    bashTool = createBashTool(cwd);
  });

  pi.registerTool({
    ...bashTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      runtime.metrics.recordRewriteAttempt();
      const resolution = resolveRtkCommand(params.command, {
        config: runtime.getConfig(),
        status: runtime.getStatus(),
        refreshStatus: () => runtime.refreshRtkStatus(),
      });

      if (resolution.status === "rewritten") {
        runtime.metrics.recordRewriteApplied();
        if (runtime.getConfig().showRewriteNotifications && ctx.hasUI) {
          ctx.ui.notify(
            `RTK rewrote bash: ${params.command} → ${resolution.command}`,
            "info"
          );
        }
      }

      if (resolution.status === "fallback" || resolution.status === "guarded") {
        runtime.metrics.recordRewriteFallback();
      }

      const config = runtime.getConfig();
      if (
        config.outputCompaction.enabled &&
        config.outputCompaction.trackSavings &&
        config.outputCompaction.compactBash
      ) {
        runtime.metrics.startCommand(toolCallId, "bash", resolution.command);
      }

      return bashTool.execute(
        toolCallId,
        {
          ...params,
          command: resolution.command,
        },
        signal,
        onUpdate,
        ctx
      );
    },
  });

  pi.on("tool_execution_start", createRtkToolExecutionStartHandler(runtime));
  pi.on("tool_result", createRtkToolResultHandler(runtime));
  pi.on("user_bash", createRtkUserBashHandler(runtime));
  registerRtkCommands(pi, runtime);
}
