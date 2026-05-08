import {
  type ExtensionHandler,
  isBashToolResult,
  isGrepToolResult,
  isReadToolResult,
  type TextContent,
  type ToolExecutionStartEvent,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";

import type { RtkConfig, RtkRuntime, RtkToolName } from "./types";

function isTextOnlyContent(
  content: ToolResultEvent["content"]
): content is [TextContent] {
  return content.length === 1 && content[0]?.type === "text";
}

function getTrackedToolName(
  toolName: string,
  config: RtkConfig
): RtkToolName | null {
  const { outputCompaction } = config;
  if (!(outputCompaction.enabled && outputCompaction.trackSavings)) {
    return null;
  }

  switch (toolName) {
    case "bash":
      return outputCompaction.compactBash ? "bash" : null;
    case "grep":
      return outputCompaction.compactGrep ? "grep" : null;
    case "read":
      return outputCompaction.compactRead ? "read" : null;
    default:
      return null;
  }
}

function isFullSkillRead(details: unknown): boolean {
  if (!(details && typeof details === "object")) {
    return false;
  }

  const value = details as {
    readPatch?: { fullSkillRead?: unknown };
    toolDisplay?: { fullSkillRead?: unknown };
  };
  return (
    value.readPatch?.fullSkillRead === true ||
    value.toolDisplay?.fullSkillRead === true
  );
}

interface RtkCompactionMetadata {
  toolName: RtkToolName;
  originalChars: number;
  finalChars: number;
  savedChars: number;
}

function mergeRtkCompactionDetails(
  details: ToolResultEvent["details"],
  metadata: RtkCompactionMetadata
): ToolResultEvent["details"] {
  return {
    ...(details && typeof details === "object" ? details : {}),
    rtkCompaction: metadata,
  };
}

function getCompactionTarget(
  event: ToolResultEvent,
  config: RtkConfig
): RtkToolName | null {
  if (event.toolName === "read" && isFullSkillRead(event.details)) {
    return null;
  }

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
  toolName: RtkToolName,
  text: string,
  config: RtkConfig
): string {
  const { maxLines, maxChars } = config.outputCompaction;
  const lines = text.split("\n");

  if (toolName === "bash") {
    return clampTail(lines.slice(-maxLines).join("\n"), maxChars);
  }

  return clampHead(lines.slice(0, maxLines).join("\n"), maxChars);
}

export function createRtkToolExecutionStartHandler(
  runtime: RtkRuntime
): ExtensionHandler<ToolExecutionStartEvent> {
  return (event) => {
    const config = runtime.getConfig();
    const toolName = getTrackedToolName(event.toolName, config);
    const label = getExecutionLabel(event);
    if (!(toolName && label)) {
      return;
    }

    runtime.metrics.startCommand(event.toolCallId, toolName, label);
  };
}

export function createRtkToolResultHandler(
  runtime: RtkRuntime
): ExtensionHandler<ToolResultEvent, ToolResultEventResult> {
  return (event) => {
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
      details: mergeRtkCompactionDetails(event.details, {
        toolName,
        originalChars: originalText.length,
        finalChars: compactedText.length,
        savedChars: originalText.length - compactedText.length,
      }),
    };
  };
}
