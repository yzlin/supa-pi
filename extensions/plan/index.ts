import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

const PROMPT = fs
  .readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt.md"),
    "utf8"
  )
  .trim();

type MessageLike = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

function buildPlanCommandMessage(task: string): string {
  if (!task) {
    return PROMPT;
  }

  return `${PROMPT}\n\n<request>\n${task}\n</request>`;
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

function getLastTaskFromSession(ctx: ExtensionCommandContext): string {
  const branch = ctx.sessionManager.getBranch();

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "message") {
      continue;
    }

    const message = entry.message as MessageLike;
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = extractTextContent(message.content);
    if (!text || text.startsWith(PROMPT)) {
      continue;
    }

    return text;
  }

  return "";
}

export default function planExtension(pi: ExtensionAPI): void {
  pi.registerCommand("plan", {
    description: "Investigate and plan in this session: /plan [what to build]",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim() || getLastTaskFromSession(ctx);
      if (!task) {
        ctx.ui.notify(
          "Usage: /plan [what to build] (or run it after a message to reuse that text)",
          "warning"
        );
        return;
      }

      const message = buildPlanCommandMessage(task);

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Queued /plan as a follow-up", "info");
    },
  });
}
