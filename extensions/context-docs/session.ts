export interface MessageLike {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

export interface SessionEntryLike {
  type?: string;
  message?: MessageLike;
}

export interface SessionEvidencePacketInput {
  entries: SessionEntryLike[];
  leafId?: string;
  maxMessages?: number;
}

function extractTextContent(content: MessageLike["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) =>
      part?.type === "text" && typeof part.text === "string" ? [part.text] : []
    )
    .join("\n")
    .trim();
}

export function buildSessionEvidencePacket({
  entries,
  leafId,
  maxMessages = 8,
}: SessionEvidencePacketInput): string {
  const messages = entries
    .filter((entry) => entry.type === "message")
    .flatMap((entry) => {
      const role = entry.message?.role;
      if (role !== "assistant" && role !== "user") {
        return [];
      }

      const text = extractTextContent(entry.message.content);
      return text ? [{ role, text }] : [];
    })
    .slice(-maxMessages);

  const lines = ["<session-evidence>"];
  if (leafId) {
    lines.push(`leaf: ${leafId}`);
  }

  for (const [index, message] of messages.entries()) {
    lines.push(`message ${index + 1} (${message.role}):`);
    lines.push(message.text);
  }

  lines.push("</session-evidence>");

  return lines.join("\n");
}
