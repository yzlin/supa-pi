import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RepoAgent } from "./agents";
import { isRecord, MODEL_PATTERN } from "./config";

// Accept raw data so structural and registry failures can be reported together.
export function validateRuntime(
  raw: Record<string, unknown>,
  selected: string | undefined,
  agents: RepoAgent[],
  ctx: ExtensionContext,
): string[] {
  const errors: string[] = [];
  const names = new Set(agents.map((agent) => agent.name));
  const profiles = isRecord(raw.profiles) ? raw.profiles : {};
  const active =
    selected ?? (typeof raw.active === "string" ? raw.active : "default");
  if (active !== "default" && !Object.hasOwn(profiles, active)) {
    errors.push(`profiles.${active}: unknown profile`);
  }
  function checkModel(values: unknown, field: string): void {
    if (
      !isRecord(values) ||
      typeof values.model !== "string" ||
      !MODEL_PATTERN.test(values.model)
    ) {
      return;
    }
    const slash = values.model.indexOf("/");
    const model = ctx.modelRegistry.find(
      values.model.slice(0, slash),
      values.model.slice(slash + 1),
    );
    if (!model) {
      errors.push(`${field}.model: unknown model ${values.model}`);
      return;
    }
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      errors.push(`${field}.model: no configured auth for ${values.model}`);
    }
    if (
      ctx.scopedModels.length &&
      !ctx.scopedModels.some(
        (item) =>
          item.model.provider === model.provider && item.model.id === model.id,
      )
    ) {
      errors.push(`${field}.model: outside model scope: ${values.model}`);
    }
  }
  for (const [name, profile] of Object.entries(profiles)) {
    // Inactive profiles may reference deleted agents; they must not block default cleanup.
    if (name !== active || !isRecord(profile)) {
      continue;
    }
    const field = `profiles.${name}`;
    checkModel(profile.main, `${field}.main`);
    if (!isRecord(profile.agents)) {
      continue;
    }
    for (const [agent, values] of Object.entries(profile.agents)) {
      if (agent !== "*" && !names.has(agent)) {
        errors.push(`${field}.agents.${agent}: unknown agent name`);
      }
      checkModel(values, `${field}.agents.${agent}`);
    }
  }
  return errors;
}
