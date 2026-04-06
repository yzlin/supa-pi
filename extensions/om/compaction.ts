import {
  type AssistantMessage,
  complete,
  type UserMessage,
} from "@mariozechner/pi-ai";

import { getModelAuthOrThrow } from "../llm-auth";
import { mergeOmCompactionSummary } from "./prompt-integration";
import type { OmStateV1 } from "./types";

type OmCompactionModel = {
  id: string;
  provider: string;
  input?: readonly string[];
};

interface OmCompactionModelRegistryLike {
  find(provider: string, modelId: string): OmCompactionModel | undefined;
  getApiKeyAndHeaders?(model: unknown): Promise<
    | {
        ok: true;
        apiKey?: string;
        headers?: Record<string, string>;
      }
    | {
        ok: false;
        error: string;
      }
  >;
  getApiKey?(model: unknown): Promise<string | undefined>;
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
}

export interface OmCompactionContext {
  model?: OmCompactionModel | null;
  modelRegistry: OmCompactionModelRegistryLike;
}

export interface OmCompactionInput {
  conversationText: string;
  previousSummary?: string | null;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface OmCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface OmCompactionOptions {
  signal?: AbortSignal;
  completeFn?: (
    model: OmCompactionModel,
    context: { messages: UserMessage[]; systemPrompt?: string },
    options?: {
      apiKey?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    }
  ) => Promise<AssistantMessage>;
}

const OM_COMPACTION_SYSTEM_PROMPT =
  "You are updating a running pi compaction summary. Follow the user prompt exactly and return concise markdown only.";

const OM_COMPACTION_MODEL_FALLBACKS = [
  ["google", "gemini-2.5-flash"],
  ["anthropic", "claude-haiku-4-5"],
  ["openai", "gpt-5-mini"],
] as const;

function resolveOmCompactionModel(
  context: OmCompactionContext
): OmCompactionModel | null {
  if (context.model) {
    return context.model;
  }

  for (const [provider, modelId] of OM_COMPACTION_MODEL_FALLBACKS) {
    const model = context.modelRegistry.find(provider, modelId);
    if (model) {
      return model;
    }
  }

  return null;
}

function extractAssistantTextContent(message: AssistantMessage): string {
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function buildOmCompactionPrompt(
  input: OmCompactionInput,
  state: OmStateV1
): string {
  return [
    "You are updating a running pi compaction summary.",
    "Rewrite the summary as concise markdown with these sections in this order:",
    "## Goal",
    "## Constraints & Preferences",
    "## Progress",
    "## Key Decisions",
    "## Next Steps",
    "## Critical Context",
    "Keep the wording compact and continuation-friendly.",
    "Do not emit an Observational Memory section; that will be merged separately.",
    "",
    "<previous_summary>",
    input.previousSummary?.trim() ?? "",
    "</previous_summary>",
    "",
    "<recent_conversation>",
    input.conversationText.trim(),
    "</recent_conversation>",
    "",
    "Return markdown only.",
  ].join("\n");
}

export async function generateOmCompactionSummary(
  context: OmCompactionContext,
  state: OmStateV1,
  input: OmCompactionInput,
  options: OmCompactionOptions = {}
): Promise<OmCompactionResult | null> {
  if (!input.previousSummary?.trim()) {
    return null;
  }

  const model = resolveOmCompactionModel(context);
  if (!model) {
    return null;
  }

  let auth: { apiKey?: string; headers?: Record<string, string> };
  try {
    auth = await getModelAuthOrThrow(context.modelRegistry, model);
  } catch {
    return null;
  }

  const prompt = buildOmCompactionPrompt(input, state);
  const runComplete = options.completeFn ?? complete;

  try {
    const response = await runComplete(
      model,
      {
        systemPrompt: OM_COMPACTION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: options.signal,
      }
    );

    if (response.stopReason === "aborted") {
      return null;
    }

    const mergedSummary = mergeOmCompactionSummary(
      extractAssistantTextContent(response),
      state
    );
    if (!mergedSummary) {
      return null;
    }

    return {
      summary: mergedSummary,
      firstKeptEntryId: input.firstKeptEntryId,
      tokensBefore: input.tokensBefore,
    };
  } catch {
    return null;
  }
}
