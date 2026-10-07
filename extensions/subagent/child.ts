// Apache-2.0 adaptation of mitsuhiko/agent-stuff, d265b8e. Modified for SupaPi: minimal child role/tool policy and schema reporter.
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { within } from "./agents";
import {
  atomicJson,
  protectFile,
  readChildConfig,
  validateStructured,
  type ChildConfig,
  type ChildResult,
  type JsonValue,
} from "./protocol";

const DELEGATION_TOOLS = new Set([
  "subagent",
  "Agent",
  "SubagentWorkflow",
  "message_parent",
  "ask_parent",
  "TaskCreate",
  "TaskList",
  "TaskGet",
  "TaskUpdate",
  "TaskOutput",
  "TaskStop",
  "TaskExecute",
]);
function cavemanInstruction(enabled?: boolean): string | undefined {
  if (enabled === undefined) {
    return;
  }
  return enabled
    ? "Use concise, telegraphic wording (caveman mode)."
    : "Do not use caveman mode; use clear complete sentences.";
}
function permitted(config: ChildConfig, name: string): boolean {
  if (name === "StructuredOutput") {
    return config.schema !== undefined;
  }
  return (
    !DELEGATION_TOOLS.has(name) &&
    !config.agent?.disallowed_tools?.includes(name) &&
    (config.agent?.tools === undefined || config.agent.tools.includes(name))
  );
}
function lastAssistant(ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "message" && entry.message.role === "assistant") {
      return entry.message;
    }
  }
  return;
}
export function registerChildBootstrap(
  pi: ExtensionAPI,
  config: ChildConfig,
  resultPath: string,
): void {
  let structuredOutput: JsonValue | undefined;
  let hasStructuredOutput = false;
  let corrected = false;
  let reported = false;
  let outcome = "completed";
  let policyError: string | undefined;
  const restrict = () => {
    const requested = config.agent?.tools ?? pi.getActiveTools();
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const missing = requested.filter((name) => !available.has(name));
    if (missing.length) {
      policyError = `Role requests unavailable tools: ${missing.join(", ")}`;
    }
    pi.setActiveTools([
      ...requested.filter((name) => permitted(config, name)),
      ...(config.schema ? ["StructuredOutput"] : []),
    ]);
  };
  const installReportTool = () => {
    if (config.schema) {
      pi.registerTool({
        name: "StructuredOutput",
        label: "Structured output",
        description:
          "Submit the final report, matching the required schema. Call once when work is complete; do not call other tools afterward.",
        parameters: config.schema,
        async execute(_id, params) {
          if (hasStructuredOutput) {
            throw new Error("StructuredOutput already submitted");
          }
          structuredOutput = validateStructured(config.schema ?? {}, params);
          hasStructuredOutput = true;
          return {
            content: [{ type: "text", text: "Final report accepted." }],
            details: {},
          };
        },
      });
    }
  };
  pi.on("tool_call", (event) => {
    if (
      policyError ||
      hasStructuredOutput ||
      !permitted(config, event.toolName)
    ) {
      return {
        block: true,
        reason:
          policyError ??
          `Tool ${event.toolName} blocked by child role policy${hasStructuredOutput ? " after final report" : ""}.`,
        terminate: true,
      };
    }
    return;
  });
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== config.runId) {
      throw new Error("Child session identity mismatch");
    }
    for (const tool of pi.getAllTools()) {
      if (
        DELEGATION_TOOLS.has(tool.name) ||
        (tool.name === "StructuredOutput" && !config.schema)
      ) {
        pi.registerTool({
          name: tool.name,
          label: tool.name,
          description: "Not available in child sessions.",
          exposure: "hidden",
          defaultActive: false,
          parameters: Type.Object({}),
          async execute() {
            throw new Error(
              "Delegation tools are not available in child sessions",
            );
          },
        });
      }
    }
    installReportTool();
    restrict();
    installPromptPolicy();
    await atomicJson(path.join(path.dirname(resultPath), "ready.json"), {
      runId: config.runId,
    });
  });
  const installPromptPolicy = () =>
    pi.on("before_agent_start", (event) => {
      restrict();
      if (config.agent?.skills === false) {
        event.systemPromptOptions.skills = [];
      }
      if (Array.isArray(config.agent?.skills)) {
        const approved = new Set(
          config.agent.skills.map((skill) =>
            path.resolve(path.dirname(config.agent?.file ?? ""), skill),
          ),
        );
        event.systemPromptOptions.skills =
          event.systemPromptOptions.skills.filter((skill) =>
            [...approved].some((root) => within(root, skill.filePath)),
          );
      }
      const instructions = [
        config.agent?.body,
        cavemanInstruction(config.agent?.caveman),
        config.schema
          ? "Finish by calling StructuredOutput with the required schema. Do not respond or use tools after the accepted final report."
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n");
      // Preserve normal workspace guidance, including extensions that already installed an opaque prompt.
      event.systemPromptOptions.forceSystemPrompt = `${event.systemPrompt}\n\n${instructions}`;
    });
  pi.on("input", (event) => {
    if (config.agent?.skills === false && /^\s*\/skill:/.test(event.text)) {
      throw new Error("Skills disabled by child role");
    }
    return { action: "continue" };
  });
  pi.on("agent_before_settle", (event) => {
    outcome = event.outcome;
    if (
      event.outcome !== "completed" ||
      event.continue ||
      policyError ||
      !config.schema ||
      hasStructuredOutput ||
      corrected
    ) {
      return;
    }
    corrected = true;
    return {
      continue: true,
      entries: [
        {
          type: "custom_message",
          customType: "subagent-report-correction",
          content:
            "The task ended without a valid StructuredOutput report. Submit the final report now through StructuredOutput. This is the only final correction; do not restart work.",
          display: false,
        },
      ],
    };
  });
  const report = async (ctx: ExtensionContext, shutdownError?: string) => {
    if (reported) {
      return;
    }
    reported = true;
    const assistant = lastAssistant(ctx);
    const failed =
      Boolean(shutdownError || policyError) ||
      outcome !== "completed" ||
      !assistant ||
      assistant.stopReason === "aborted" ||
      assistant.stopReason === "error" ||
      Boolean(config.schema && !hasStructuredOutput);
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      await protectFile(sessionFile);
    }
    const result: ChildResult = {
      version: 1,
      runId: config.runId,
      parentSessionId: config.parentSessionId,
      schemaHash: config.schemaHash,
      agent: config.agent?.name,
      provider: ctx.model?.provider ?? config.provider,
      model: ctx.model?.id ?? config.model,
      thinking: pi.getThinkingLevel(),
      status: failed ? "failed" : "completed",
      output:
        assistant?.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n") ?? "",
      structuredOutput: hasStructuredOutput ? structuredOutput : undefined,
      error: failed
        ? (shutdownError ??
          policyError ??
          assistant?.errorMessage ??
          (config.schema && !hasStructuredOutput
            ? "Missing valid StructuredOutput after one final correction."
            : `Child ended: ${outcome}`))
        : undefined,
      sessionFile,
      finishedAt: Date.now(),
    };
    await atomicJson(resultPath, result);
  };
  pi.on("agent_settled", async (_event, ctx) => {
    await report(ctx);
    ctx.shutdown();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!reported) {
      await report(ctx, "Child shut down before settling.");
    }
  });
}
export default async function childExtension(pi: ExtensionAPI): Promise<void> {
  const configPath = process.env.SUPA_PI_SUBAGENT_CONFIG;
  if (!configPath) {
    throw new Error("Child bootstrap requires SUPA_PI_SUBAGENT_CONFIG");
  }
  const config = await readChildConfig(configPath);
  registerChildBootstrap(
    pi,
    config,
    path.join(path.dirname(configPath), "result.json"),
  );
}
