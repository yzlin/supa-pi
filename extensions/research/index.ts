import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROMPT = fs
  .readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt.md"),
    "utf8"
  )
  .trim();

export function buildResearchCommandMessage(args: string): string {
  const topic = args.trim();
  return `${PROMPT}\n\nResearch request: ${topic}`;
}

export default function researchExtension(pi: ExtensionAPI): void {
  pi.registerCommand("research", {
    description:
      "Run research through pi-tasks with the researcher agent: /research <topic>",
    handler: async (args, ctx) => {
      const topic = (args ?? "").trim();
      if (!topic) {
        ctx.ui.notify("Usage: /research <topic>", "warning");
        return;
      }

      const message = buildResearchCommandMessage(topic);

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Queued /research as a follow-up", "info");
    },
  });
}
