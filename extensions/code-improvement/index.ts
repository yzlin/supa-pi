import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXTENSION_DIR = dirname(new URL(import.meta.url).pathname);

function readPrompt(fileName: string): string {
  return readFileSync(join(EXTENSION_DIR, fileName), "utf8").trim();
}

const SIMPLIFY_PROMPT = readPrompt("SIMPLIFY.md");
const IMPROVE_CODEBASE_ARCHITECTURE_PROMPT = [
  "IMPROVE-CODEBASE-ARCHITECTURE.md",
  "LANGUAGE.md",
  "DEEPENING.md",
  "INTERFACE-DESIGN.md",
]
  .map(readPrompt)
  .join("\n\n");

export function buildSimplifyCommandMessage(args: string): string {
  const focus = args.trim();
  const focusInstruction = focus
    ? `Focus instruction: ${focus}`
    : "Focus instruction: Simplify the recent feature implementation or recently modified code in this session.";

  return `${SIMPLIFY_PROMPT}\n\n${focusInstruction}`;
}

export function buildImproveCodebaseArchitectureCommandMessage(
  args: string
): string {
  const scope = args.trim();
  const scopeInstruction = scope
    ? `Scope instruction: ${scope}`
    : "Scope instruction: No explicit scope provided. Start broad, then narrow based on explorer findings.";

  return `${IMPROVE_CODEBASE_ARCHITECTURE_PROMPT}\n\n${scopeInstruction}`;
}

export default function codeImprovementExtension(pi: ExtensionAPI): void {
  pi.registerCommand("simplify", {
    description: "Simplify recent code or a focused scope: /simplify [focus]",
    handler: (args, ctx) => {
      const message = buildSimplifyCommandMessage(args ?? "");

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Queued /simplify as a follow-up", "info");
    },
  });

  pi.registerCommand("improve-codebase-architecture", {
    description:
      "Read-only architecture review with deepening candidates: /improve-codebase-architecture [scope]",
    handler: (args, ctx) => {
      const message = buildImproveCodebaseArchitectureCommandMessage(
        args ?? ""
      );

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify(
        "Queued /improve-codebase-architecture as a follow-up",
        "info"
      );
    },
  });
}
