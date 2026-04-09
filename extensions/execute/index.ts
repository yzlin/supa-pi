import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import { EXECUTE_COMMAND_NAME, EXECUTE_PROMPT } from "./constants";

type MessageLike = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

function buildExecuteCommandMessage(args: string): string {
  const plan = args.trim();
  return plan ? `${EXECUTE_PROMPT}\n\n<plan>\n${plan}\n</plan>` : EXECUTE_PROMPT;
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
      part?.type === "text" && typeof part.text === "string"
        ? [part.text]
        : []
    )
    .join("\n")
    .trim();
}

function getLastPlanFromSession(ctx: ExtensionCommandContext): string {
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
    if (!text || text.startsWith(EXECUTE_PROMPT)) {
      continue;
    }

    return text;
  }

  return "";
}

export default function executeExtension(pi: ExtensionAPI): void {
  pi.registerCommand(EXECUTE_COMMAND_NAME, {
    description:
      "Execute a plan via main-session task orchestration: /execute [plan]",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim() || getLastPlanFromSession(ctx);
      if (!task) {
        ctx.ui.notify(
          "Usage: /execute [plan] (or run it after a message to reuse that text)",
          "warning"
        );
        return;
      }

      const message = buildExecuteCommandMessage(task);
      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Queued /execute as a follow-up", "info");
    },
  });
}
