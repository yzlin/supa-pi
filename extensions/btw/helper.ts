export interface ParsedBtwArgs {
  task: string;
  model?: string;
}

export interface ResolveModelResult {
  model?: any;
  thinkingLevel: string;
  error?: string;
}

/**
 * Parse /btw args.
 * Supports an optional leading -model provider/modelId flag.
 */
export function parseBtwArgs(args: string): ParsedBtwArgs {
  const trimmedArgs = args.trim();
  const modelMatch = trimmedArgs.match(/^-model\s+(\S+)(?:\s+|$)/);

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
  modelRegistry: { find: (provider: string, modelId: string) => any },
  currentModel: any,
  currentThinkingLevel: string,
  params: { model?: string }
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

  const resolvedModel = modelRegistry.find(
    params.model.slice(0, slashIdx),
    params.model.slice(slashIdx + 1)
  );

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
