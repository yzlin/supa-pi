import { detectSecret } from "./secrets";

export interface ContextDocsPromptInput {
  basePrompt: string;
  request: string;
  evidencePacket: string;
}

export type ContextDocsPromptResult =
  | { ok: true; prompt: string }
  | { ok: false; reason: string };

export function buildContextDocsPrompt({
  basePrompt,
  request,
  evidencePacket,
}: ContextDocsPromptInput): ContextDocsPromptResult {
  const combined = `${request}\n${evidencePacket}`;
  const secret = detectSecret(combined);

  if (secret.hasSecret) {
    return {
      ok: false,
      reason: `Refusing to build context-docs prompt: possible ${secret.reason}.`,
    };
  }

  const trimmedRequest =
    request.trim() || "Extract durable context-docs from the session evidence.";

  return {
    ok: true,
    prompt: `${basePrompt.trim()}\n\n<handoff>\n${trimmedRequest}\n</handoff>\n\n${evidencePacket.trim()}`,
  };
}
