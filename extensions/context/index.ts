import {
  buildSessionContext,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

import { analyzeSessionContext } from "./analyze";
import {
  buildContextContentSnapshot,
  type CachedContextEventSnapshot,
  captureContextEventSnapshot,
} from "./content";
import { showContextContentView } from "./content-view";
import { showContextView } from "./view";

export default function (pi: ExtensionAPI) {
  let cachedContextSnapshot: CachedContextEventSnapshot | null = null;

  pi.on("context", (event, ctx) => {
    cachedContextSnapshot = captureContextEventSnapshot(ctx, event.messages);
  });

  pi.on("session_switch", () => {
    cachedContextSnapshot = null;
  });

  pi.on("session_shutdown", () => {
    cachedContextSnapshot = null;
  });

  pi.registerCommand("context", {
    description:
      "Show active context usage, or /context content for assembled context",
    getArgumentCompletions(argumentPrefix) {
      const trimmed = argumentPrefix.trimStart();
      return "content".startsWith(trimmed)
        ? [{ value: "content", label: "content" }]
        : null;
    },
    handler: async (args, ctx) => {
      if (args.trim() === "content") {
        const snapshot = buildContextContentSnapshot(
          ctx,
          cachedContextSnapshot
        );
        await showContextContentView(ctx, snapshot);
        return;
      }

      const entries = ctx.sessionManager.getEntries();
      const usage = ctx.getContextUsage();
      const sessionContext = buildSessionContext(
        entries,
        ctx.sessionManager.getLeafId()
      );
      const sessionModel =
        ctx.model ??
        (sessionContext.model
          ? ctx.modelRegistry.find(
              sessionContext.model.provider,
              sessionContext.model.modelId
            )
          : undefined);

      const snapshot = analyzeSessionContext({
        entries,
        leafId: ctx.sessionManager.getLeafId(),
        systemPrompt: ctx.getSystemPrompt(),
        contextUsage: usage,
        contextWindow: usage?.contextWindow ?? sessionModel?.contextWindow ?? 0,
        modelLabel: sessionModel?.id ?? ctx.model?.id ?? "no-model",
      });

      await showContextView(ctx, snapshot);
    },
  });
}
