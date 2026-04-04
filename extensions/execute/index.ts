import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { EXECUTE_COMMAND_NAME, EXECUTE_PROMPT } from "./constants";

const buildExecuteCommandMessage = (args: string): string => {
  const task = args.trim();
  return task ? `${EXECUTE_PROMPT}\n\nTask: ${task}` : EXECUTE_PROMPT;
};

export default function executeExtension(pi: ExtensionAPI): void {
  pi.registerCommand(EXECUTE_COMMAND_NAME, {
    description:
      "Execute a plan via main-session task orchestration: /execute <plan>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify("Usage: /execute <plan>", "warning");
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
