import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_SESSION_DIAGNOSIS_REQUEST = "current session";
const DIAGNOSE_INVOCATION_PREAMBLE =
  "Use the `diagnose` skill behavior as canonical.\n\nDiagnose invocation packet:";

export function buildDiagnoseCommandMessage(args: string): string {
  const request = args.trim() || DEFAULT_SESSION_DIAGNOSIS_REQUEST;

  return `${DIAGNOSE_INVOCATION_PREAMBLE}\n- Diagnosis request: ${request}`;
}

export default function diagnoseExtension(pi: ExtensionAPI): void {
  pi.registerCommand("diagnose", {
    description: "Diagnose a bug or current session: /diagnose [request]",
    handler: async (args, ctx) => {
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
