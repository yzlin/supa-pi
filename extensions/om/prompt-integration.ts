import { buildOmCompactionPayload, buildOmHeader } from "./prompts";
import type { OmStateV1 } from "./types";

export const OM_HEADER_CUSTOM_TYPE = "om-header";

interface OmContextMessageLike {
  role?: string;
  customType?: string;
  content?: unknown;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }

      const record = part as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string"
        ? [record.text]
        : [];
    })
    .join("\n")
    .trim();
}

export function createOmHeaderContextMessage(state: OmStateV1): {
  role: "custom";
  customType: typeof OM_HEADER_CUSTOM_TYPE;
  content: string;
  display: false;
  timestamp: number;
} | null {
  const content = buildOmHeader(state);
  if (!content.trim()) {
    return null;
  }

  return {
    role: "custom",
    customType: OM_HEADER_CUSTOM_TYPE,
    content,
    display: false,
    timestamp: Date.now(),
  };
}

export function shouldInjectOmHeader(
  messages: readonly OmContextMessageLike[],
  headerText: string
): boolean {
  const normalizedHeaderText = normalizeText(headerText);
  if (!normalizedHeaderText) {
    return false;
  }

  return !messages.some((message) => {
    if (message.customType === OM_HEADER_CUSTOM_TYPE) {
      return true;
    }

    return extractTextContent(message.content).includes(normalizedHeaderText);
  });
}

export function injectOmHeaderMessage<TMessage extends OmContextMessageLike>(
  messages: readonly TMessage[],
  state: OmStateV1
): Array<TMessage | ReturnType<typeof createOmHeaderContextMessage>> {
  const headerMessage = createOmHeaderContextMessage(state);
  if (
    !headerMessage ||
    !shouldInjectOmHeader(messages, headerMessage.content)
  ) {
    return [...messages];
  }

  return [headerMessage, ...messages];
}

export function mergeOmCompactionSummary(
  summary: string | null | undefined,
  state: OmStateV1
): string | null {
  const normalizedSummary = normalizeText(summary);
  if (!normalizedSummary) {
    return null;
  }

  const payload = buildOmCompactionPayload(state);
  if (!payload.trim()) {
    return normalizedSummary;
  }

  const summaryWithoutOm = normalizedSummary
    .replace(/\n\n## Observational Memory[\s\S]*$/u, "")
    .trimEnd();

  return `${summaryWithoutOm}\n\n${payload}`.trim();
}
