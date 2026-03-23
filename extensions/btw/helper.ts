/**
 * Resolve a target model and thinking level from mode/model parameters.
 * Returns the resolved model and thinking level, using defaults from the
 * current context if not overridden.
 */
export async function resolveModelAndThinking(
  cwd: string,
  modelRegistry: any,
  currentModel: any,
  currentThinkingLevel: string,
  params: { mode?: string; model?: string }
): Promise<{ model: any; thinkingLevel: string }> {
  let targetModel = currentModel;
  let targetThinkingLevel = currentThinkingLevel;

  if (params.model) {
    const slashIdx = params.model.indexOf("/");
    if (slashIdx > 0) {
      const m = modelRegistry.find(
        params.model.slice(0, slashIdx),
        params.model.slice(slashIdx + 1)
      );
      if (m) targetModel = m;
    }
  }

  return { model: targetModel, thinkingLevel: targetThinkingLevel };
}
