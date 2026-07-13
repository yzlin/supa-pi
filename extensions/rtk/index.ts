import type { Static } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  createBashTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { ToolDisplayBashOutputConfig } from "../tool-display/config";
import { loadToolDisplayConfig } from "../tool-display/config";
import {
  cleanupToolDisplayTimers,
  composeReasonedTool,
  type PresentationState,
  renderBashToolCall,
  renderBashToolResult,
  toolResultBody,
} from "../tool-display/presentation";
import { renderCompactBashResult } from "../tool-display/renderers";
import { registerRtkCommands } from "./commands";
import { loadRtkConfig } from "./config";
import {
  createRtkToolExecutionStartHandler,
  createRtkToolResultHandler,
} from "./output-compaction";
import { clearRtkBinaryPathCache, resolveRtkCommand } from "./rewrite";
import { createRtkRuntime } from "./runtime";
import type { RtkRuntime } from "./types";
import { createRtkUserBashHandler } from "./user-bash";

const REASONING_DESCRIPTION =
  "State short present-tense intent, maximum 12 words, without restating target";
const REASONING_GUIDELINE =
  "Give bash a short present-tense reasoning goal without repeating its command";

type BashTool = ReturnType<typeof createBashTool>;
type BashSchema = BashTool["parameters"];
type BashDetails = Awaited<ReturnType<BashTool["execute"]>>["details"];
type RtkExecutionTool = ToolDefinition<
  BashSchema,
  BashDetails,
  PresentationState
>;

function loadRuntimeState(cwd: string, runtime: RtkRuntime): void {
  clearRtkBinaryPathCache();
  runtime.setConfig(loadRtkConfig(cwd));
  runtime.resetSessionState();
  runtime.refreshRtkStatus();
}

function withRtkExecution(
  baseTool: BashTool,
  runtime: RtkRuntime
): RtkExecutionTool {
  return {
    ...baseTool,
    execute(
      toolCallId: string,
      params: Static<BashSchema>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<BashDetails> | undefined,
      ctx: ExtensionContext
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

      return baseTool.execute(
        toolCallId,
        { ...params, command: resolution.command },
        signal,
        onUpdate
      );
    },
  };
}

/** Compose RTK-owned execution with optional shared tool-display presentation. */
export function createRtkBashTool(
  baseTool: BashTool,
  runtime: RtkRuntime,
  getOutputConfig: () => ToolDisplayBashOutputConfig
) {
  const rtkTool = withRtkExecution(baseTool, runtime);
  if (!getOutputConfig().enabled) {
    return rtkTool;
  }

  return composeReasonedTool(
    {
      ...rtkTool,
      renderShell: "self" as const,
      renderCall: (args, theme, context) =>
        renderBashToolCall(args, theme, context),
      renderResult: (result, options, theme, context) => {
        const outputConfig = getOutputConfig();
        const body =
          options.expanded || outputConfig.mode === "expanded"
            ? toolResultBody(
                renderCompactBashResult(
                  result,
                  { ...options, expanded: true },
                  theme,
                  outputConfig
                ),
                true
              )
            : undefined;
        return renderBashToolResult(result, options, theme, context, body);
      },
    },
    {
      reasoningDescription: REASONING_DESCRIPTION,
      promptGuidelines: [REASONING_GUIDELINE],
    }
  );
}

export default function rtkExtension(pi: ExtensionAPI): void {
  const runtime = createRtkRuntime(loadRtkConfig(process.cwd()));
  let toolDisplayConfig = loadToolDisplayConfig(process.cwd());
  const registeredDefinition = createRtkBashTool(
    createBashTool(process.cwd()),
    runtime,
    () => toolDisplayConfig.output.bash
  );

  function reloadSession(cwd: string): void {
    cleanupToolDisplayTimers("rtk");
    loadRuntimeState(cwd, runtime);
    toolDisplayConfig = loadToolDisplayConfig(cwd);
    const nextDefinition = createRtkBashTool(
      createBashTool(cwd),
      runtime,
      () => toolDisplayConfig.output.bash
    );
    registeredDefinition.promptGuidelines = undefined;
    registeredDefinition.renderShell = undefined;
    registeredDefinition.renderCall = undefined;
    registeredDefinition.renderResult = undefined;
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
        ctx: ExtensionContext
      ) => void
    ): void;
  };
  sessionSwitchApi.on("session_switch", (_event, ctx) => {
    reloadSession(ctx.cwd);
    pi.registerTool(registeredDefinition);
  });
  pi.on("session_shutdown", () => {
    cleanupToolDisplayTimers("rtk");
  });

  pi.registerTool(registeredDefinition);

  pi.on("tool_execution_start", createRtkToolExecutionStartHandler(runtime));
  pi.on("tool_result", createRtkToolResultHandler(runtime));
  pi.on("user_bash", createRtkUserBashHandler(runtime));
  registerRtkCommands(pi, runtime);
}
