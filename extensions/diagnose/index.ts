import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const EXTENSION_DIR = dirname(new URL(import.meta.url).pathname);
const PROMPT = readFileSync(join(EXTENSION_DIR, "prompt.md"), "utf8").trim();
const DEFAULT_SESSION_DIAGNOSIS_REQUEST =
  "Diagnose the current session. First inspect recent conversation context and identify the active failure or ambiguity; if none, ask one clarifying question.";

export function buildDiagnoseCommandMessage(args: string): string {
  const request = args.trim() || DEFAULT_SESSION_DIAGNOSIS_REQUEST;

  return `${PROMPT}\n\nDiagnosis request: ${request}`;
}

export default function diagnoseExtension(pi: ExtensionAPI): void {
  pi.registerCommand("diagnose", {
    description: "Diagnose a bug or current session: /diagnose [request]",
    handler: (args, ctx) => {
      const message = buildDiagnoseCommandMessage(args ?? "");

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Queued /diagnose as a follow-up", "info");
    },
  });
}
