/*
 * Copied from `agent-stuff` by original author Armin Ronacher (mitsuhiko).
 * Source: https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/notify.ts
 * Original license: Apache License 2.0.
 * Local changes: added this attribution notice, repository formatting/lint rules,
 * and a named macOS notification app because OSC notifications fail in the live setup.
 */

/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting for input.
 * Uses a cached AppleScript app on macOS in Ghostty and OSC 777 elsewhere.
 *
 * OSC-supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  notifierDirectory: string;
  compileId: string;
  environment: NodeJS.ProcessEnv;
  exists(path: string): boolean;
  mkdir(path: string, options: { recursive: true; mode: number }): void;
  rename(oldPath: string, newPath: string): void;
  remove(path: string, options: { recursive: true; force: true }): void;
  spawn(
    command: string,
    args: string[],
    options: { stdio: "ignore"; env?: NodeJS.ProcessEnv }
  ): NotificationChildProcess;
  spawnSync(
    command: string,
    args: string[],
    options: { stdio: "ignore" }
  ): { status: number | null };
  write(text: string): void;
}

const notificationAppName = "Pi agent.app";
const notificationAppScript = `on run
  set notificationTitle to system attribute "PI_AGENT_NOTIFICATION_TITLE"
  set notificationBody to system attribute "PI_AGENT_NOTIFICATION_BODY"
  display notification notificationBody with title notificationTitle
end run`;
const notificationAppVersion = createHash("sha256")
  .update(notificationAppScript)
  .digest("hex")
  .slice(0, 12);

const defaultRuntime: NotificationRuntime = {
  platform: process.platform,
  termProgram: process.env.TERM_PROGRAM,
  notifierDirectory: join(
    homedir(),
    "Library",
    "Caches",
    "pi-agent-notifier",
    notificationAppVersion
  ),
  compileId: `${process.pid}-${randomUUID()}`,
  environment: process.env,
  exists: existsSync,
  mkdir: mkdirSync,
  rename: renameSync,
  remove: rmSync,
  spawn,
  spawnSync,
  write: (text) => process.stdout.write(text),
};

/**
 * Send through a named macOS app in Ghostty or OSC 777 elsewhere.
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

  if (runtime.platform !== "darwin" || runtime.termProgram !== "ghostty") {
    writeOscNotification();
    return;
  }

  const appPath = join(runtime.notifierDirectory, notificationAppName);
  const executablePath = join(appPath, "Contents", "MacOS", "applet");
  let child: NotificationChildProcess;

  try {
    runtime.mkdir(runtime.notifierDirectory, {
      recursive: true,
      mode: 0o700,
    });

    if (!runtime.exists(executablePath)) {
      const temporaryDirectory = join(
        runtime.notifierDirectory,
        `.compile-${runtime.compileId}`
      );
      const temporaryAppPath = join(temporaryDirectory, notificationAppName);
      runtime.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      const result = runtime.spawnSync(
        "/usr/bin/osacompile",
        ["-o", temporaryAppPath, "-e", notificationAppScript],
        { stdio: "ignore" }
      );
      if (result.status === 0) {
        try {
          runtime.rename(temporaryAppPath, appPath);
        } catch {
          // Another Pi process may have published the same cached app first.
        }
      }
      try {
        runtime.remove(temporaryDirectory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of a private cache directory.
      }
      if (!runtime.exists(executablePath)) {
        writeOscNotification();
        return;
      }
    }

    child = runtime.spawn(executablePath, [], {
      stdio: "ignore",
      env: {
        ...runtime.environment,
        PI_AGENT_NOTIFICATION_TITLE: title,
        PI_AGENT_NOTIFICATION_BODY: body,
      },
    });
  } catch {
    writeOscNotification();
    return;
  }

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
