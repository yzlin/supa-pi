import type { Static } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  createBashTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { registerRtkCommands } from "./commands";
import { loadRtkConfig } from "./config";
import {
  createRtkToolExecutionStartHandler,
  createRtkToolResultHandler,
} from "./output-compaction";
import { withReasonedBash } from "./reasoned-bash";
import { clearRtkBinaryPathCache, resolveRtkCommand } from "./rewrite";
import { createRtkRuntime } from "./runtime";
import type { RtkRuntime } from "./types";
import { createRtkUserBashHandler } from "./user-bash";

type BashTool = ReturnType<typeof createBashTool>;
type BashSchema = BashTool["parameters"];
type BashDetails = Awaited<ReturnType<BashTool["execute"]>>["details"];
type RtkExecutionTool = ToolDefinition<BashSchema, BashDetails>;

function loadRuntimeState(cwd: string, runtime: RtkRuntime): void {
  clearRtkBinaryPathCache();
  runtime.setConfig(loadRtkConfig(cwd));
  runtime.resetSessionState();
  runtime.refreshRtkStatus();
}

function withRtkExecution(
  baseTool: BashTool,
  runtime: RtkRuntime,
): RtkExecutionTool {
  return {
    ...baseTool,
    execute(
      toolCallId: string,
      params: Static<BashSchema>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<BashDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<BashDetails>> {
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
            "info",
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

      return baseTool.execute(
        toolCallId,
        { ...params, command: resolution.command },
        signal,
        onUpdate,
      );
    },
  };
}

/** RTK owns bash execution and reasoning, not drawing. */
export function createRtkBashTool(baseTool: BashTool, runtime: RtkRuntime) {
  return withReasonedBash(withRtkExecution(baseTool, runtime));
}

export default function rtkExtension(pi: ExtensionAPI): void {
  const runtime = createRtkRuntime(loadRtkConfig(process.cwd()));
  const registeredDefinition = createRtkBashTool(
    createBashTool(process.cwd()),
    runtime,
  );

  function reloadSession(cwd: string): void {
    loadRuntimeState(cwd, runtime);
    const nextDefinition = createRtkBashTool(createBashTool(cwd), runtime);
    Object.assign(registeredDefinition, nextDefinition);
  }

  pi.on("session_start", (_event, ctx) => {
    reloadSession(ctx.cwd);
    pi.registerTool(registeredDefinition);
  });
  const sessionSwitchApi = pi as ExtensionAPI & {
    on(
      event: "session_switch",
      handler: (
        event: { type: "session_switch" },
        ctx: ExtensionContext,
      ) => void,
    ): void;
  };
  sessionSwitchApi.on("session_switch", (_event, ctx) => {
    reloadSession(ctx.cwd);
    pi.registerTool(registeredDefinition);
  });
  pi.registerTool(registeredDefinition);

  pi.on("tool_execution_start", createRtkToolExecutionStartHandler(runtime));
  pi.on("tool_result", createRtkToolResultHandler(runtime));
  pi.on("user_bash", createRtkUserBashHandler(runtime));
  registerRtkCommands(pi, runtime);
}
