import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROMPT = fs
  .readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), "prompt.md"),
    "utf8"
  )
  .trim();

function buildMessage(args: string): string {
  const focus = args.trim();
  const focusInstruction = focus
    ? `Focus instruction: ${focus}`
    : "Focus instruction: Simplify the recent feature implementation or recently modified code in this session.";

  return `${PROMPT}\n\n${focusInstruction}`;
}

export default function simplifyExtension(pi: ExtensionAPI): void {
  pi.registerCommand("simplify", {
    description: "Simplify recent code or a focused scope: /simplify [focus]",
    handler: async (args, ctx) => {
      const message = buildMessage(args ?? "");

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Queued /simplify as a follow-up", "info");
    },
  });
}
