import {
  isBashToolResult,
  isGrepToolResult,
  isReadToolResult,
  type TextContent,
  type ToolExecutionStartEvent,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@mariozechner/pi-coding-agent";

import type { PiRtkConfig, PiRtkRuntime, PiRtkToolName } from "./types";

function isTextOnlyContent(
  content: ToolResultEvent["content"]
): content is [TextContent] {
  return content.length === 1 && content[0]?.type === "text";
}

function getTrackedToolName(
  toolName: string,
  config: PiRtkConfig
): PiRtkToolName | null {
  const { outputCompaction } = config;
  if (!outputCompaction.enabled || !outputCompaction.trackSavings) {
    return null;
  }

  if (toolName === "bash") {
    return outputCompaction.compactBash ? "bash" : null;
  }

  if (toolName === "grep") {
    return outputCompaction.compactGrep ? "grep" : null;
  }

  if (toolName === "read") {
    return outputCompaction.compactRead ? "read" : null;
  }

  return null;
}

function getCompactionTarget(
  event: ToolResultEvent,
  config: PiRtkConfig
): PiRtkToolName | null {
  if (
    isBashToolResult(event) ||
    isGrepToolResult(event) ||
    isReadToolResult(event)
  ) {
    return getTrackedToolName(event.toolName, config);
  }

  return null;
}

function getExecutionLabel(event: ToolExecutionStartEvent): string | null {
  if (event.toolName === "grep") {
    return "grep";
  }

  if (event.toolName === "read") {
    return "read";
  }

  return null;
}

function clampHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return maxChars === 1 ? "…" : `${text.slice(0, maxChars - 1)}…`;
}

function clampTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return maxChars === 1 ? "…" : `…${text.slice(-(maxChars - 1))}`;
}

function compactText(
  toolName: PiRtkToolName,
  text: string,
  config: PiRtkConfig
): string {
  const { maxLines, maxChars } = config.outputCompaction;
  const lines = text.split("\n");
  const lineLimited =
    toolName === "bash"
      ? lines.slice(-maxLines).join("\n")
      : lines.slice(0, maxLines).join("\n");

  return toolName === "bash"
    ? clampTail(lineLimited, maxChars)
    : clampHead(lineLimited, maxChars);
}

export function createRtkToolExecutionStartHandler(runtime: PiRtkRuntime) {
  return async (event: ToolExecutionStartEvent): Promise<void> => {
    const config = runtime.getConfig();
    const toolName = getTrackedToolName(event.toolName, config);
    const label = getExecutionLabel(event);
    if (!toolName || !label) {
      return;
    }

    runtime.metrics.startCommand(event.toolCallId, toolName, label);
  };
}

export function createRtkToolResultHandler(runtime: PiRtkRuntime) {
  return async (
    event: ToolResultEvent
  ): Promise<ToolResultEventResult | void> => {
    const config = runtime.getConfig();
    const toolName = getCompactionTarget(event, config);
    if (!toolName) {
      return;
    }

    if (!isTextOnlyContent(event.content)) {
      runtime.metrics.completeCommand(event.toolCallId);
      return;
    }

    const originalText = event.content[0].text;
    const compactedText = compactText(toolName, originalText, config);

    runtime.metrics.recordToolSavings(
      toolName,
      originalText.length,
      compactedText.length
    );
    runtime.metrics.completeCommand(event.toolCallId, {
      inputText: originalText,
      outputText: compactedText,
    });

    if (compactedText === originalText) {
      return;
    }

    return {
      content: [{ type: "text", text: compactedText }],
    };
  };
}
