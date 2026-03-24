import {
  buildSessionContext,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

import { analyzeSessionContext } from "./analyze";
import { showContextView } from "./view";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("context", {
    description: "Show active context usage and estimated bucket breakdown",
    handler: async (_args, ctx) => {
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
