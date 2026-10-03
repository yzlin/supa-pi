import {
  buildSessionContext,
  convertToLlm,
  type SessionEntry,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";

const TOP_LEVEL_REGEX_1 = /^-model\s+(\S+)(?:\s+|$)/;

export const BTW_MESSAGE_TYPE = "btw-result";

/**
 * Serialize the conversation for a /btw subagent.
 * Uses the compaction-aware session context (same view as the main agent),
 * not the raw branch, so long sessions stay within the model window.
 */
export function buildBtwConversationContext(
  entries: SessionEntry[],
  leafId: string | null,
): string {
  const messages = buildSessionContext(entries, leafId).messages.filter(
    (m) => !(m.role === "custom" && m.customType === BTW_MESSAGE_TYPE),
  );
  return messages.length > 0
    ? serializeConversation(convertToLlm(messages))
    : "";
}
export interface ParsedBtwArgs {
  task: string;
  model?: string;
}

export interface ResolveModelResult {
  model?: unknown;
  thinkingLevel: string;
  error?: string;
}

interface ScopedModelEntry {
  model: { provider: string; id: string };
  thinkingLevel?: string;
}

/**
 * Parse /btw args.
 * Supports an optional leading -model provider/modelId flag.
 */
export function parseBtwArgs(args: string): ParsedBtwArgs {
  const trimmedArgs = args.trim();
  const modelMatch = trimmedArgs.match(TOP_LEVEL_REGEX_1);

  if (!modelMatch) {
    return { task: trimmedArgs };
  }

  return {
    model: modelMatch[1],
    task: trimmedArgs.slice(modelMatch[0].length).trim(),
  };
}

/**
 * Resolve a target model and thinking level from model parameters.
 * Returns an error when the requested model is invalid or unknown.
 */
export function resolveModelAndThinking(
  modelRegistry: { find: (provider: string, modelId: string) => unknown },
  currentModel: unknown,
  currentThinkingLevel: string,
  params: { model?: string },
  scopedModels: readonly ScopedModelEntry[] = [],
): ResolveModelResult {
  if (!params.model) {
    return { model: currentModel, thinkingLevel: currentThinkingLevel };
  }

  const slashIdx = params.model.indexOf("/");
  if (slashIdx <= 0) {
    return {
      thinkingLevel: currentThinkingLevel,
      error: `Invalid model format "${params.model}", expected provider/modelId`,
    };
  }

  const provider = params.model.slice(0, slashIdx);
  const modelId = params.model.slice(slashIdx + 1);
  if (scopedModels.length > 0) {
    const scoped = scopedModels.find(
      ({ model }) => model.provider === provider && model.id === modelId,
    );
    if (!scoped) {
      return {
        thinkingLevel: currentThinkingLevel,
        error: `Model ${params.model} is outside the current model scope`,
      };
    }
    return {
      model: scoped.model,
      thinkingLevel: scoped.thinkingLevel ?? currentThinkingLevel,
    };
  }

  const resolvedModel = modelRegistry.find(provider, modelId);

  if (!resolvedModel) {
    return {
      thinkingLevel: currentThinkingLevel,
      error: `Unknown model ${params.model}`,
    };
  }

  return {
    model: resolvedModel,
    thinkingLevel: currentThinkingLevel,
  };
}
