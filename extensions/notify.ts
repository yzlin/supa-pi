/*
 * Copied from `agent-stuff` by original author Armin Ronacher (mitsuhiko).
 * Source: https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/notify.ts
 * Original license: Apache License 2.0.
 * Local changes: added this attribution notice, repository formatting/lint rules,
 * and native macOS Ghostty delivery because OSC notifications fail in the live setup.
 */

/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting for input.
 * Uses Ghostty-targeted AppleScript on macOS and OSC 777 elsewhere.
 *
 * OSC-supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty
 */

import { spawn } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  type MarkdownTheme,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";

interface NotificationChildProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
  unref(): void;
}

interface NotificationRuntime {
  platform: NodeJS.Platform;
  termProgram?: string;
  spawn(
    command: string,
    args: string[],
    options: { stdio: "ignore" }
  ): NotificationChildProcess;
  write(text: string): void;
}

const defaultRuntime: NotificationRuntime = {
  platform: process.platform,
  termProgram: process.env.TERM_PROGRAM,
  spawn,
  write: (text) => process.stdout.write(text),
};

const ghosttyNotificationScript = `on run argv
  tell application "Ghostty"
    display notification (item 2 of argv) with title (item 1 of argv)
  end tell
end run`;

/**
 * Send a desktop notification through Ghostty on macOS or OSC 777 elsewhere.
 */
const notify = (
  title: string,
  body: string,
  runtime: NotificationRuntime
): void => {
  const writeOscNotification = () => {
    // OSC 777 format: ESC ] 777 ; notify ; title ; body BEL
    runtime.write(`\x1b]777;notify;${title};${body}\x07`);
  };

  if (runtime.platform === "darwin" && runtime.termProgram === "ghostty") {
    const child = runtime.spawn(
      "/usr/bin/osascript",
      ["-e", ghosttyNotificationScript, "--", title, body],
      { stdio: "ignore" }
    );
    let didFallBack = false;
    const fallBackToOsc = () => {
      if (didFallBack) {
        return;
      }
      didFallBack = true;
      writeOscNotification();
    };
    child.once("error", fallBackToOsc);
    child.once("close", (code) => {
      if (code !== 0) {
        fallBackToOsc();
      }
    });
    child.unref();
    return;
  }

  writeOscNotification();
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
  pi.on("agent_end", (event) => {
    const lastText = extractLastAssistantText(event.messages ?? []);
    const { title, body } = formatNotification(lastText);
    notify(title, body, runtime);
  });
}
