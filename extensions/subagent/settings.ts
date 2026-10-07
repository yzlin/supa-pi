// Apache-2.0 adaptation of mitsuhiko/agent-stuff, d265b8e. Modified for SupaPi: explicit > role > parent settings and launch preflight.
import { isThinking, type AgentDefinition, type Thinking } from "./agents";
import type { RunnerAPI, RunnerContext, SubagentParams } from "./runner";
export function selectSettings(
  pi: RunnerAPI,
  ctx: RunnerContext,
  params: SubagentParams,
  agent?: AgentDefinition,
): { provider: string; model: string; thinking: Thinking } {
  let provider = ctx.model?.provider ?? "";
  let model = ctx.model?.id ?? "";
  if (agent?.model) {
    const slash = agent.model.indexOf("/");
    if (
      slash <= 0 ||
      slash === agent.model.length - 1 ||
      /\s/.test(agent.model)
    ) {
      throw new Error("Agent model must be provider/model");
    }
    provider = agent.model.slice(0, slash);
    model = agent.model.slice(slash + 1);
  }
  if (params.provider !== undefined) {
    if (!params.provider.trim() || /\s/.test(params.provider)) {
      throw new Error("Invalid provider");
    }
    provider = params.provider;
  }
  if (params.model !== undefined) {
    if (!params.model.trim() || /\s/.test(params.model)) {
      throw new Error("Invalid model");
    }
    model = params.model;
    const slash = model.indexOf("/");
    if (
      slash > 0 &&
      (!params.provider || model.slice(0, slash) === params.provider)
    ) {
      provider = model.slice(0, slash);
      model = model.slice(slash + 1);
    }
  }
  const thinking = params.thinking ?? agent?.thinking ?? pi.getThinkingLevel();
  if (!isThinking(thinking)) {
    throw new Error("Invalid thinking level");
  }
  const selected = ctx.modelRegistry.find(provider, model);
  if (!selected) {
    throw new Error(`Unknown model: ${provider}/${model}`);
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(selected)) {
    throw new Error(`No configured auth for ${provider}/${model}`);
  }
  if (
    ctx.scopedModels.length &&
    !ctx.scopedModels.some(
      (item) => item.model.provider === provider && item.model.id === model,
    )
  ) {
    throw new Error(`Model outside parent scope: ${provider}/${model}`);
  }
  return { provider, model, thinking };
}
