import {
  isBashToolResult,
  isGrepToolResult,
  isReadToolResult,
  type TextContent,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@mariozechner/pi-coding-agent";

import type { PiRtkConfig, PiRtkRuntime, PiRtkToolName } from "./types";

function isTextOnlyContent(
  content: ToolResultEvent["content"]
): content is [TextContent] {
  return content.length === 1 && content[0]?.type === "text";
}

function getCompactionTarget(
  event: ToolResultEvent,
  config: PiRtkConfig
): PiRtkToolName | null {
  const { outputCompaction } = config;
  if (!outputCompaction.enabled) {
    return null;
  }

  if (isBashToolResult(event)) {
    return outputCompaction.compactBash ? "bash" : null;
  }

  if (isGrepToolResult(event)) {
    return outputCompaction.compactGrep ? "grep" : null;
  }

  if (isReadToolResult(event)) {
    return outputCompaction.compactRead ? "read" : null;
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

export function createRtkToolResultHandler(runtime: PiRtkRuntime) {
  return async (event: ToolResultEvent): Promise<ToolResultEventResult | void> => {
    const config = runtime.getConfig();
    const toolName = getCompactionTarget(event, config);
    if (!toolName || !isTextOnlyContent(event.content)) {
      return;
    }

    const originalText = event.content[0].text;
    const compactedText = compactText(toolName, originalText, config);
    if (compactedText === originalText) {
      return;
    }

    if (config.outputCompaction.trackSavings) {
      runtime.metrics.recordToolSavings(
        toolName,
        originalText.length,
        compactedText.length
      );
    }

    return {
      content: [{ type: "text", text: compactedText }],
    };
  };
}
