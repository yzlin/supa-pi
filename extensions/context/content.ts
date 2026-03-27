import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import {
  buildSessionContext,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

export type ContextContentSource =
  | "context_event_snapshot"
  | "reconstructed_session";

export interface ContextContentBlock {
  label: string;
  content: string;
}

export interface ContextContentMessage {
  role: AgentMessage["role"];
  title: string;
  metadata: string[];
  blocks: ContextContentBlock[];
}

export interface ContextContentSnapshot {
  source: ContextContentSource;
  sourceNote: string;
  systemPrompt: string;
  modelLabel: string;
  thinkingLevel: string;
  messageCount: number;
  messages: ContextContentMessage[];
}

export interface CachedContextEventSnapshot {
  sessionId: string;
  leafId: string | null;
  entryCount: number;
  messages: AgentMessage[];
}

function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
  if (typeof structuredClone === "function") {
    return structuredClone(messages);
  }

  return JSON.parse(JSON.stringify(messages)) as AgentMessage[];
}

function formatJson(value: unknown): string {
  const rendered = JSON.stringify(value ?? {}, null, 2);
  return rendered ?? "{}";
}

function isTextContent(part: TextContent | ImageContent): part is TextContent {
  return part.type === "text";
}

function isImageContent(
  part: TextContent | ImageContent
): part is ImageContent {
  return part.type === "image";
}

function formatImage(image: ImageContent): string {
  return `[image: ${image.mimeType}, ${image.data.length} base64 chars]`;
}

function formatContentParts(
  content: string | (TextContent | ImageContent)[],
  defaultLabel = "content"
): ContextContentBlock[] {
  if (typeof content === "string") {
    return [
      {
        label: defaultLabel,
        content: content || "(empty)",
      },
    ];
  }

  if (content.length === 0) {
    return [{ label: defaultLabel, content: "(empty)" }];
  }

  return content.map((part, index) => {
    if (isTextContent(part)) {
      return {
        label: content.length === 1 ? defaultLabel : `text ${index + 1}`,
        content: part.text || "(empty)",
      };
    }

    if (isImageContent(part)) {
      return {
        label: `image ${index + 1}`,
        content: formatImage(part),
      };
    }

    return {
      label: `part ${index + 1}`,
      content: formatJson(part),
    };
  });
}

function normalizeMessage(
  message: AgentMessage,
  index: number
): ContextContentMessage {
  const titlePrefix = `[${index + 1}]`;

  switch (message.role) {
    case "user":
      return {
        role: message.role,
        title: `${titlePrefix} user`,
        metadata: [],
        blocks: formatContentParts(message.content),
      };

    case "assistant":
      return {
        role: message.role,
        title: `${titlePrefix} assistant`,
        metadata: [
          `${message.provider}/${message.model}`,
          `stop=${message.stopReason}`,
        ],
        blocks:
          message.content.length > 0
            ? message.content.map((block, blockIndex) => {
                if (block.type === "text") {
                  return {
                    label: `text ${blockIndex + 1}`,
                    content: block.text || "(empty)",
                  };
                }

                if (block.type === "thinking") {
                  return {
                    label: block.redacted
                      ? `thinking ${blockIndex + 1} (redacted)`
                      : `thinking ${blockIndex + 1}`,
                    content:
                      block.thinking ||
                      (block.redacted
                        ? "[redacted thinking payload]"
                        : "(empty)"),
                  };
                }

                return {
                  label: `tool call ${blockIndex + 1} · ${block.name}`,
                  content: formatJson(block.arguments),
                };
              })
            : [{ label: "content", content: "(empty)" }],
      };

    case "toolResult":
      return {
        role: message.role,
        title: `${titlePrefix} tool result`,
        metadata: [
          `tool=${message.toolName}`,
          message.isError ? "error" : "ok",
        ],
        blocks: formatContentParts(message.content),
      };

    case "bashExecution":
      return {
        role: message.role,
        title: `${titlePrefix} bash execution`,
        metadata: [
          `exit=${message.exitCode ?? "unknown"}`,
          message.truncated ? "truncated" : "complete",
          message.excludeFromContext ? "excluded-from-context" : "in-context",
        ],
        blocks: [
          {
            label: "command",
            content: message.command || "(empty)",
          },
          {
            label: "output",
            content: message.output || "(empty)",
          },
        ],
      };

    case "custom":
      return {
        role: message.role,
        title: `${titlePrefix} custom`,
        metadata: [
          `type=${message.customType}`,
          message.display ? "displayed" : "hidden",
        ],
        blocks: formatContentParts(message.content),
      };

    case "branchSummary":
      return {
        role: message.role,
        title: `${titlePrefix} branch summary`,
        metadata: [`from=${message.fromId}`],
        blocks: [{ label: "summary", content: message.summary || "(empty)" }],
      };

    case "compactionSummary":
      return {
        role: message.role,
        title: `${titlePrefix} compaction summary`,
        metadata: [`tokensBefore=${message.tokensBefore}`],
        blocks: [{ label: "summary", content: message.summary || "(empty)" }],
      };
  }

  return {
    role: message.role,
    title: `${titlePrefix} ${message.role}`,
    metadata: ["unrecognized message shape"],
    blocks: [{ label: "content", content: formatJson(message) }],
  };
}

export function captureContextEventSnapshot(
  ctx: ExtensionContext,
  messages: AgentMessage[]
): CachedContextEventSnapshot {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    leafId: ctx.sessionManager.getLeafId(),
    entryCount: ctx.sessionManager.getEntries().length,
    messages: cloneMessages(messages),
  };
}

function isCurrentSnapshot(
  ctx: ExtensionCommandContext,
  snapshot: CachedContextEventSnapshot | null
): snapshot is CachedContextEventSnapshot {
  if (!snapshot) {
    return false;
  }

  return (
    snapshot.sessionId === ctx.sessionManager.getSessionId() &&
    snapshot.leafId === ctx.sessionManager.getLeafId() &&
    snapshot.entryCount === ctx.sessionManager.getEntries().length
  );
}

function resolveModelLabel(
  ctx: ExtensionCommandContext,
  model: {
    provider: string;
    modelId: string;
  } | null
): string {
  if (ctx.model) {
    return ctx.model.id;
  }

  if (model) {
    const resolved = ctx.modelRegistry.find(model.provider, model.modelId);
    if (resolved) {
      return resolved.id;
    }

    return `${model.provider}/${model.modelId}`;
  }

  return "no-model";
}

export function buildContextContentSnapshot(
  ctx: ExtensionCommandContext,
  cachedSnapshot: CachedContextEventSnapshot | null
): ContextContentSnapshot {
  const sessionContext = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId()
  );
  const source = isCurrentSnapshot(ctx, cachedSnapshot)
    ? "context_event_snapshot"
    : "reconstructed_session";
  const rawMessages =
    source === "context_event_snapshot"
      ? cachedSnapshot.messages
      : sessionContext.messages;

  return {
    source,
    sourceNote:
      source === "context_event_snapshot"
        ? "Source: cached higher-fidelity context snapshot from the context event."
        : cachedSnapshot
          ? "Source: reconstructed current session context (cached context snapshot was stale)."
          : "Source: reconstructed current session context (no cached context snapshot yet).",
    systemPrompt: ctx.getSystemPrompt() || "",
    modelLabel: resolveModelLabel(ctx, sessionContext.model),
    thinkingLevel: sessionContext.thinkingLevel,
    messageCount: rawMessages.length,
    messages: rawMessages.map((message, index) =>
      normalizeMessage(message, index)
    ),
  };
}
