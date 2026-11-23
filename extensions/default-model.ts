import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Workaround for a Pi 1.6.0 startup race: the first availability pass checks
 * every provider in one `Promise.all`, so one failing auth check drops
 * extension providers (such as `claude-code`) from the configured set, and
 * `findInitialModel` falls back from the settings default. Re-check only the
 * default provider and switch back when Pi fell back on a fresh session.
 */

const MODEL_FLAGS = new Set(["--model", "--provider", "--models"]);
const REFRESH_TIMEOUT_MS = 10_000;

export interface DefaultModelTarget {
  provider: string;
  id: string;
}

export interface RestoreInput {
  reason: string;
  argv: readonly string[];
  defaultProvider: string | undefined;
  defaultModel: string | undefined;
  current: { provider: string; id: string } | undefined;
  scopedModelCount: number;
  hasMessages: boolean;
}

/** The default model to restore, or undefined when Pi's choice must stand. */
export function defaultModelToRestore(
  input: RestoreInput,
): DefaultModelTarget | undefined {
  // Only startup runs findInitialModel; `/new` keeps the user's current model.
  if (input.reason !== "startup") {
    return;
  }
  if (!(input.defaultProvider && input.defaultModel)) {
    return;
  }
  if (input.hasMessages || input.scopedModelCount > 0) {
    return;
  }
  if (input.argv.some((arg) => MODEL_FLAGS.has(arg.split("=")[0] ?? arg))) {
    return;
  }
  const { current } = input;
  if (
    current?.provider === input.defaultProvider &&
    current.id === input.defaultModel
  ) {
    return;
  }
  return { provider: input.defaultProvider, id: input.defaultModel };
}

function hasMessages(ctx: ExtensionContext): boolean {
  return ctx.sessionManager
    .getEntries()
    .some((entry) => entry.type === "message");
}

async function restoreDefaultModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  target: DefaultModelTarget,
): Promise<void> {
  const label = `${target.provider}/${target.id}`;
  const fallback = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
  try {
    await ctx.modelRegistry.refresh({
      providers: [target.provider],
      allowNetwork: false,
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    // The checks below report whether the default became usable.
  }
  const model = ctx.modelRegistry.find(target.provider, target.id);
  if (model && (await pi.setModel(model))) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Restored default model ${label} (startup picked ${fallback})`,
        "info",
      );
    }
    return;
  }
  if (ctx.hasUI) {
    ctx.ui.notify(
      `Default model ${label} is unavailable; using ${fallback}`,
      "warning",
    );
  }
}

export default function defaultModelExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    const settings = pi.getSettings();
    const target = defaultModelToRestore({
      reason: event.reason,
      argv: process.argv,
      defaultProvider: settings.defaultProvider,
      defaultModel: settings.defaultModel,
      current: ctx.model,
      scopedModelCount: ctx.scopedModels.length,
      hasMessages: hasMessages(ctx),
    });
    if (target) {
      await restoreDefaultModel(pi, ctx, target);
    }
  });
}
