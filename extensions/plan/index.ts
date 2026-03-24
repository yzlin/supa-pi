import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROMPT = fs
  .readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt.md"),
    "utf8"
  )
  .trim();

export default function (pi: ExtensionAPI) {
  pi.registerCommand("plan", {
    description: "Investigate and plan in this session: /plan <what to build>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify("Usage: /plan <what to build>", "warning");
        return;
      }

      const message = `${PROMPT}\n\nTask: ${task}`;

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Queued /plan as a follow-up", "info");
    },
  });
}
