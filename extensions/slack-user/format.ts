import { truncateHead } from "@earendil-works/pi-coding-agent";

import type { SlackMessage, SlackThread } from "./slack.js";
import type { SlackPermalink } from "./url.js";

const MAX_OUTPUT_BYTES = 48 * 1024;
const MAX_OUTPUT_LINES = 1800;
const MAX_MESSAGE_CHARACTERS = 8000;

export interface FormattedSlackThread {
  text: string;
  outputTruncated: boolean;
}

function decodeSlackEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function formatSlackText(text: string, users: Map<string, string>): string {
  return decodeSlackEntities(
    text
      .replace(
        /<@([A-Z0-9]+)>/g,
        (_match, userId: string) => `@${users.get(userId) ?? userId}`,
      )
      .replace(
        /<#([A-Z0-9]+)\|([^>]+)>/g,
        (_match, _channelId: string, channelName: string) => `#${channelName}`,
      )
      .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
      .replace(/<(https?:\/\/[^>]+)>/g, "$1"),
  );
}

function messageAuthor(
  message: SlackMessage,
  users: Map<string, string>,
): string {
  if (message.user) {
    return users.get(message.user) ?? message.user;
  }
  return (
    message.bot_profile?.name?.trim() || message.username?.trim() || "Slack app"
  );
}

function formatTimestamp(ts: string): string {
  const date = new Date(Number(ts) * 1000);
  if (Number.isNaN(date.valueOf())) {
    return ts;
  }
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

function limitMessageText(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARACTERS) {
    return text;
  }
  return `${text.slice(0, MAX_MESSAGE_CHARACTERS)}\n\n[message text truncated]`;
}

function formatFiles(message: SlackMessage): string[] {
  if (!message.files?.length) {
    return [];
  }

  return message.files.map((file) => {
    const label =
      file.title?.trim() || file.name?.trim() || file.id || "Slack file";
    const metadata = [file.id, file.mimetype].filter(Boolean).join(" · ");
    const link = file.permalink ? ` — ${file.permalink}` : "";
    return `- 📎 ${label}${metadata ? ` (${metadata})` : ""}${link}`;
  });
}

export function formatSlackThread(
  target: SlackPermalink,
  thread: SlackThread,
): FormattedSlackThread {
  const lines = [
    `# Slack thread in ${target.channelId}`,
    "",
    `Source: ${target.originalUrl}`,
    `Messages: ${thread.messages.length}${thread.truncatedByMessageLimit ? " (more available)" : ""}`,
  ];

  if (thread.messages.length === 0) {
    lines.push("", "No messages returned.");
  }

  for (const message of thread.messages) {
    const text = limitMessageText(
      formatSlackText(message.text?.trim() || "[no text]", thread.users),
    );
    lines.push(
      "",
      `## ${messageAuthor(message, thread.users)} — ${formatTimestamp(message.ts)}`,
      "",
      text,
    );

    const files = formatFiles(message);
    if (files.length > 0) {
      lines.push("", ...files);
    }
  }

  if (thread.truncatedByMessageLimit) {
    lines.push(
      "",
      "[Thread stopped at the requested message limit. Increase max_messages to fetch more.]",
      "",
    );
  }

  const formatted = lines.join("\n");
  const truncated = truncateHead(formatted, {
    maxBytes: MAX_OUTPUT_BYTES,
    maxLines: MAX_OUTPUT_LINES,
  });

  if (!truncated.truncated) {
    return { text: formatted, outputTruncated: false };
  }

  return {
    text: `${truncated.content}\n\n[Output truncated to protect Pi context. No local Slack transcript was written.]`,
    outputTruncated: true,
  };
}
