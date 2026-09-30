import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  SettingsManager,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import { type RepoAgent, readRepoAgents } from "./agents";
import {
  type Config,
  loadConfig,
  type Profile,
  type Values,
  WHITESPACE,
  writeConfig,
} from "./config";
import { applyPlan, assertOutsideRepo, observeLive, planAgents } from "./files";
import { validateRuntime } from "./validation";

const WORD_SEPARATOR = /\s+/;

export interface Options {
  agentDir?: string;
  repoAgentsDir?: string;
  persistMain?: (
    cwd: string,
    agentDir: string,
    values: Values,
  ) => Promise<void>;
}

export async function persistMain(
  cwd: string,
  agentDir: string,
  values: Values,
): Promise<void> {
  const settings = SettingsManager.create(cwd, agentDir);
  // These setters update globalSettings, not project settings (Pi 0.86.1).
  if (values.model) {
    const slash = values.model.indexOf("/");
    settings.setDefaultModelAndProvider(
      values.model.slice(0, slash),
      values.model.slice(slash + 1),
    );
  }
  if (values.thinking) {
    settings.setDefaultThinkingLevel(values.thinking);
  }
  await settings.flush();
  const errors = settings.drainErrors();
  if (errors.length) {
    throw new Error(
      `Could not persist model defaults: ${errors.map((error) => error.error.message).join("; ")}`,
    );
  }
}

export function registerModelProfiles(
  pi: ExtensionAPI,
  options: Options = {},
): void {
  const agentDir = options.agentDir ?? getAgentDir();
  const repoDir =
    options.repoAgentsDir ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../agents");
  const liveDir = join(agentDir, "agents");
  const configPath = join(agentDir, "model-profiles.json");
  const persist = options.persistMain ?? persistMain;
  let cachedNames: string[] = [];
  let queue = Promise.resolve();

  function guarded(
    ctx: ExtensionContext,
    action: () => void | Promise<void>,
  ): Promise<void> {
    queue = queue.then(action).catch((error: unknown) => {
      ctx.ui.notify(
        String(error instanceof Error ? error.message : error),
        "error",
      );
    });
    return queue;
  }

  function read(
    ctx: ExtensionContext,
    selected?: string,
  ): { config: Config; agents: RepoAgent[] } | undefined {
    // Missing config is explicitly a no-op; don't even observe the live agents directory.
    let agents: RepoAgent[] = [];
    const config = loadConfig(configPath, (raw) => {
      agents = readRepoAgents(repoDir);
      return validateRuntime(raw, selected, agents, ctx);
    });
    cachedNames = config ? Object.keys(config.profiles) : [];
    return config ? { config, agents } : undefined;
  }
  function status(ctx: ExtensionContext, name: string): void {
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "model-profiles",
        name === "default" ? undefined : `profile: ${name}`,
      );
    }
  }
  function render(
    ctx: ExtensionContext,
    agents: RepoAgent[],
    profile: Profile,
  ): void {
    const plan = planAgents(agents, profile, observeLive(liveDir, repoDir));
    applyPlan(liveDir, repoDir, plan);
    if (plan.warnings.length) {
      ctx.ui.notify(plan.warnings.join("\n"), "warning");
    }
  }
  function refresh(ctx: ExtensionContext): void {
    const state = read(ctx);
    const name = state?.config.active ?? "default";
    if (state) {
      render(
        ctx,
        state.agents,
        name === "default" ? {} : state.config.profiles[name],
      );
    }
    status(ctx, name);
  }

  async function switchProfile(
    name: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const state = read(ctx, name);
    if (!state && name !== "default") {
      throw new Error(`${configPath}: unknown profile ${name}`);
    }
    const config = state?.config ?? { profiles: {} };
    const agents = state?.agents ?? readRepoAgents(repoDir);
    const profile = name === "default" ? {} : config.profiles[name];
    // Build the full plan before any main changes, including directory ownership checks.
    const plan = planAgents(agents, profile, observeLive(liveDir, repoDir));
    assertOutsideRepo(configPath, repoDir);
    if (profile.main?.model || profile.main?.thinking) {
      assertOutsideRepo(join(agentDir, "settings.json"), repoDir);
    }
    // Pi's setModel resets thinking to model/global defaults; keep the current level unless the profile sets one.
    const currentThinking = pi.getThinkingLevel();
    if (profile.main?.model) {
      const slash = profile.main.model.indexOf("/");
      const model = ctx.modelRegistry.find(
        profile.main.model.slice(0, slash),
        profile.main.model.slice(slash + 1),
      );
      if (!(model && (await pi.setModel(model)))) {
        throw new Error(
          `${configPath}: profiles.${name}.main.model: auth failure setting ${profile.main.model}`,
        );
      }
    }
    if (profile.main?.thinking) {
      pi.setThinkingLevel(profile.main.thinking);
    } else if (profile.main?.model) {
      pi.setThinkingLevel(currentThinking);
    }
    applyPlan(liveDir, repoDir, plan);
    if (profile.main && (profile.main.model || profile.main.thinking)) {
      await persist(ctx.cwd, agentDir, profile.main);
    }
    // Re-read after the awaits so profiles saved by other sessions meanwhile are not overwritten.
    const latest = loadConfig(configPath) ?? { profiles: {} };
    writeConfig(configPath, { ...latest, active: name });
    if (plan.warnings.length) {
      ctx.ui.notify(plan.warnings.join("\n"), "warning");
    }
    status(ctx, name);
    ctx.ui.notify(`profile: ${name}`, "info");
  }

  function save(name: string, ctx: ExtensionCommandContext): void {
    if (!name || name === "default" || WHITESPACE.test(name)) {
      throw new Error(
        `${configPath}: save requires a non-reserved profile name (not default)`,
      );
    }
    if (!ctx.model) {
      throw new Error("Cannot save profile: no current model");
    }
    // Saving a snapshot does not apply or change the active profile.
    const config = read(ctx)?.config ?? { profiles: {} };
    const main: Values = {
      model: `${ctx.model.provider}/${ctx.model.id}`,
      thinking: pi.getThinkingLevel(),
    };
    const next = {
      ...config,
      profiles: {
        ...config.profiles,
        [name]: { ...config.profiles[name], main },
      },
    };
    assertOutsideRepo(configPath, repoDir);
    writeConfig(configPath, next);
    cachedNames = Object.keys(next.profiles);
    ctx.ui.notify(`Saved profile: ${name}`, "info");
  }

  pi.on("session_start", (_event, ctx) => guarded(ctx, () => refresh(ctx)));
  // Block spawns only when stale generated overrides could run with the wrong model.
  function refreshForSpawn(
    ctx: ExtensionContext,
  ): ToolCallEventResult | undefined {
    try {
      refresh(ctx);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      ctx.ui.notify(message, "error");
      let generated = true;
      try {
        const live = observeLive(liveDir, repoDir);
        generated = Object.values(live.entries).some(
          (entry) => entry.kind === "generated",
        );
      } catch {
        // Unknown live state: stay conservative and block.
      }
      if (generated) {
        return {
          block: true,
          reason: `model-profiles refresh failed; agent overrides may be stale: ${message}`,
        };
      }
    }
  }
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "Agent" || event.toolName === "SubagentWorkflow") {
      const run = queue.then(() => refreshForSpawn(ctx));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }
  });
  pi.registerCommand("profile", {
    description: "Model profiles: /profile [name|default|status|save <name>]",
    getArgumentCompletions(prefix) {
      return ["default", ...cachedNames, "save", "status"]
        .filter((name) => name.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value }));
    },
    handler(args, ctx) {
      return guarded(ctx, async () => {
        const words = args.trim().split(WORD_SEPARATOR);
        const command = words[0];
        if (command === "save" && words.length === 2) {
          save(words[1], ctx);
          return;
        }
        if ((!command || command === "status") && words.length === 1) {
          const state = read(ctx);
          const active = state?.config.active ?? "default";
          status(ctx, active);
          if (command === "status" || !ctx.hasUI) {
            ctx.ui.notify(`profile: ${active}`, "info");
            return;
          }
          const names = [
            "default",
            ...Object.keys(state?.config.profiles ?? {}),
          ];
          const labels = names.map((name) =>
            name === active ? `${name} (active)` : name,
          );
          const choice = await ctx.ui.select("Model profile", labels);
          if (choice !== undefined) {
            const index = labels.indexOf(choice);
            if (index >= 0) {
              await switchProfile(names[index], ctx);
            }
          }
          return;
        }
        if (words.length !== 1 || command === "save") {
          throw new Error("Usage: /profile [name|default|status|save <name>]");
        }
        await switchProfile(command, ctx);
      });
    },
  });
}

export default function modelProfiles(pi: ExtensionAPI): void {
  registerModelProfiles(pi);
}
