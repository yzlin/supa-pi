/*
 * Copied from `agent-stuff` by original author Armin Ronacher (mitsuhiko).
 * Source: https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/notify.ts
 * Original license: Apache License 2.0.
 * Local changes: added this attribution notice, repository formatting/lint rules,
 * and Herdr-aware notification routing.
 */

/**
 * Desktop Notification Extension
 *
 * Sends a desktop notification when the agent finishes and is waiting for input.
 * Uses Herdr's notification API inside Herdr and OSC 777 elsewhere.
 *
 * OSC-supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty
 */

import { execFile } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  type MarkdownTheme,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";

interface NotificationRuntime {
  environment: NodeJS.ProcessEnv;
  execFile(
    command: string,
    args: string[],
    callback: (error: Error | null, stdout: string) => void
  ): void;
  write(text: string): void;
}

const defaultRuntime: NotificationRuntime = {
  environment: process.env,
  execFile: (command, args, callback) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 5000, killSignal: "SIGTERM" },
      callback
    );
  },
  write: (text) => process.stdout.write(text),
};

const wasHerdrNotificationShown = (stdout: string): boolean => {
  try {
    const response = JSON.parse(stdout) as { result?: { shown?: unknown } };
    return response.result?.shown === true;
  } catch {
    return false;
  }
};

/**
 * Send through Herdr's notification API inside Herdr or OSC 777 elsewhere.
 */
const notify = (
  title: string,
  body: string,
  runtime: NotificationRuntime,
  onHerdrFailure: () => void
): void => {
  if (runtime.environment.HERDR_ENV !== "1") {
    // OSC 777 format: ESC ] 777 ; notify ; title ; body BEL
    runtime.write(`\x1b]777;notify;${title};${body}\x07`);
    return;
  }

  try {
    runtime.execFile(
      "herdr",
      ["notification", "show", title, "--body", body, "--sound", "none"],
      (error, stdout) => {
        if (error || !wasHerdrNotificationShown(stdout)) {
          onHerdrFailure();
        }
      }
    );
  } catch {
    onHerdrFailure();
  }
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
  Boolean(
    part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part
  );

const extractLastAssistantText = (
  messages: Array<{ role?: string; content?: unknown }>
): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") {
      continue;
    }

    const content = message.content;
    if (typeof content === "string") {
      return content.trim() || null;
    }

    if (Array.isArray(content)) {
      const text = content
        .filter(isTextPart)
        .map((part) => part.text)
        .join("\n")
        .trim();
      return text || null;
    }

    return null;
  }

  return null;
};

const plainMarkdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: () => "",
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: () => "",
  quote: (text) => text,
  quoteBorder: () => "",
  hr: () => "",
  listBullet: () => "",
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
  const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
  return markdown.render(width).join("\n");
};

const formatNotification = (
  text: string | null
): { title: string; body: string } => {
  const simplified = text ? simpleMarkdown(text) : "";
  // Markdown emits OSC 8 hyperlinks. Embedding one OSC sequence inside the OSC
  // 777 notification terminates the notification early and prints its visible
  // text at the terminal cursor. Remove terminal sequences and remaining control
  // characters before constructing the outer OSC sequence.
  const normalized = stripTerminalSequences(simplified)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return { title: "Ready for input", body: "" };
  }

  const maxBody = 200;
  const body =
    normalized.length > maxBody
      ? `${normalized.slice(0, maxBody - 1)}…`
      : normalized;
  return { title: "π", body };
};

export default function (
  pi: ExtensionAPI,
  runtime: NotificationRuntime = defaultRuntime
) {
  pi.on("agent_end", (event, ctx) => {
    const lastText = extractLastAssistantText(event.messages ?? []);
    const { title, body } = formatNotification(lastText);
    notify(title, body, runtime, () => {
      ctx.ui.notify("Desktop notification failed.", "warning");
    });
  });
}
