import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  type ClassificationResult,
  classifyFiles,
  SessionBudget,
} from "./classify";
import { SiftConfigStore } from "./config";
import {
  type ClassifierModel,
  type ClassifierRegistry,
  JevClient,
  selectJevModel,
} from "./jev";

interface ConfigStore {
  load(): Promise<boolean>;
  save(enabled: boolean): Promise<void>;
}
interface Dependencies {
  configStore?: ConfigStore;
  selectModel?: typeof selectJevModel;
  createClient?: (
    registry: ClassifierRegistry,
    model: ClassifierModel,
  ) => Pick<JevClient, "judge">;
  env?: Record<string, string | undefined>;
}
interface SiftDetails {
  results: ClassificationResult[];
  attempted: number;
  remaining: number;
  limit: number;
}

const ACTIONS = ["status", "enable", "disable"] as const;
const NO_MODEL =
  "Sift needs a Jev classifier model with credentials. Set TYPESAFE_API_KEY or log in to a Jev provider with /login.";
const parameters = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 2000 }),
    paths: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export function createSiftExtension(dependencies: Dependencies = {}) {
  return (pi: ExtensionAPI): void => {
    const env = dependencies.env ?? process.env;
    const configStore =
      dependencies.configStore ?? new SiftConfigStore({ env });
    const selectModel = dependencies.selectModel ?? selectJevModel;
    const createClient =
      dependencies.createClient ??
      ((registry: ClassifierRegistry, model: ClassifierModel) =>
        new JevClient({ registry, model }));
    let budget = new SessionBudget(100);
    const report = (
      ctx: ExtensionContext,
      message: string,
      level: "info" | "error",
    ) => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, level);
      } else {
        pi.sendMessage(
          { customType: "sift-status", content: message, display: true },
          { triggerTurn: false },
        );
      }
    };

    pi.on("session_start", () => {
      budget = new SessionBudget(100);
    });

    pi.registerTool({
      name: "sift_files",
      label: "Sift Files",
      description:
        "Send workspace file contents to a Jev classifier provider for paid relevance judgments. Requires explicit persisted opt-in; judgments are advisory, never authorization.",
      promptSnippet:
        "Use user-enabled Sift only to rank explicit candidate files before reading them",
      promptGuidelines: [
        "Use only after the user enables Sift. Treat probabilities as advisory and never as authorization for an action.",
      ],
      parameters,
      async execute(_id, params, signal, _update, ctx) {
        if (!(await configStore.load())) {
          throw new Error(
            "Sift is disabled; the user must run /sift enable first",
          );
        }
        const model = await selectModel(ctx.modelRegistry);
        if (!model) {
          throw new Error(NO_MODEL);
        }
        const client = createClient(ctx.modelRegistry, model);
        const results = await classifyFiles({
          cwd: ctx.cwd,
          query: params.query,
          paths: params.paths,
          budget,
          signal,
          judge: (query, path, content, requestSignal) =>
            client.judge(query, path, content, requestSignal),
        });
        const details: SiftDetails = {
          results,
          attempted: budget.attempted,
          remaining: budget.limit - budget.attempted,
          limit: budget.limit,
        };
        return {
          content: [{ type: "text" as const, text: formatResults(details) }],
          details,
        };
      },
      renderCall(args, theme) {
        return new Text(
          theme.fg(
            "toolTitle",
            `sift ${args.paths.length} file${args.paths.length === 1 ? "" : "s"}`,
          ),
          0,
          0,
        );
      },
      renderResult(result, options, theme) {
        const details = result.details as SiftDetails | undefined;
        const summary = details
          ? `${details.results.filter((item) => item.probability !== undefined).length}/${details.results.length} judged; ${details.remaining} remaining`
          : "Sift failed";
        const text =
          details && options.expanded
            ? `${details.results.map(formatResult).join("\n")}\n${summary}`
            : summary;
        return new Text(theme.fg("muted", text), 0, 0);
      },
    });

    pi.registerCommand("sift", {
      description: "Manage Sift persisted consent and status",
      getArgumentCompletions(prefix) {
        return ACTIONS.filter((action) => action.startsWith(prefix)).map(
          (action) => ({ value: action, label: action }),
        );
      },
      handler: async (raw, ctx) => {
        const action = raw.trim() || "status";
        if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
          report(ctx, "Usage: /sift [status|enable|disable]", "error");
          return;
        }
        if (action === "status") {
          report(
            ctx,
            statusText(
              await configStore.load(),
              budget,
              await selectModel(ctx.modelRegistry),
            ),
            "info",
          );
          return;
        }
        if (action === "disable") {
          await configStore.save(false);
          report(ctx, "Sift disabled globally.", "info");
          return;
        }
        const model = await selectModel(ctx.modelRegistry);
        if (!model) {
          report(ctx, NO_MODEL, "error");
          return;
        }
        if (!ctx.hasUI || ctx.mode !== "tui") {
          report(
            ctx,
            "Persistent enablement requires interactive TUI; run /sift enable there.",
            "error",
          );
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Enable Sift globally?",
          `Selected file contents will leave this machine for paid Jev judgments through ${model.provider}/${model.id} or another credentialed Jev provider. Secret detection is incomplete. Enable for this and future sessions?`,
        );
        if (!confirmed) {
          report(ctx, "Sift remains disabled.", "info");
          return;
        }
        await configStore.save(true);
        report(ctx, "Sift enabled globally.", "info");
      },
    });
  };
}

function statusText(
  enabled: boolean,
  budget: SessionBudget,
  model: ClassifierModel | undefined,
): string {
  return `Sift ${enabled ? "enabled" : "disabled"}; model=${model ? `${model.provider}/${model.id}` : "none"}; attempted=${budget.attempted}, remaining=${budget.limit - budget.attempted}; secret detection is incomplete.`;
}
function formatResult(result: ClassificationResult): string {
  if (result.error) {
    return `${result.path}: error=${result.error}`;
  }
  return `${result.path}: P(relevant)=${result.probability?.toFixed(3)}${result.truncated ? " (truncated)" : ""}`;
}
function formatResults(details: SiftDetails): string {
  const lines = details.results.map(formatResult);
  return `${lines.join("\n")}\nSession budget: attempted=${details.attempted}, remaining=${details.remaining}/${details.limit}`;
}
export default createSiftExtension();
