import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  type ClassificationResult,
  classifyFiles,
  SessionBudget,
} from "./classify";
import {
  type CredentialStatus,
  CredentialStore,
  type ResolvedCredential,
} from "./credentials";
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  JevClient,
  JevError,
  type JevFailureCategory,
  type JevJudgment,
} from "./jev";

interface Store {
  status(): Promise<CredentialStatus>;
  resolve(): Promise<ResolvedCredential>;
  save(value: string): Promise<void>;
  clear(): Promise<void>;
}
interface Client {
  judge(
    query: string,
    path: string,
    content: string,
    signal?: AbortSignal
  ): Promise<JevJudgment>;
}
interface Dependencies {
  credentialStore?: Store;
  createClient?: (apiKey: string) => Client;
  readSecret?: (ctx: ExtensionContext) => Promise<string | undefined>;
  env?: Record<string, string | undefined>;
}
interface SiftDetails {
  results: ClassificationResult[];
  attempted: number;
  remaining: number;
  limit: number;
}

const ACTIONS = ["login", "logout", "status", "enable", "disable"] as const;
const PRINTABLE_KEY = /^[!-~]+$/;
const parameters = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 2000 }),
    paths: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

export function createSiftExtension(dependencies: Dependencies = {}) {
  return (pi: ExtensionAPI): void => {
    const env = dependencies.env ?? process.env;
    const store = dependencies.credentialStore ?? new CredentialStore({ env });
    const createClient =
      dependencies.createClient ??
      ((apiKey: string) => new JevClient({ apiKey }));
    const readSecret = dependencies.readSecret ?? hiddenInput;
    let enabled = env.PI_SIFT_ENABLED === "1";
    let budget = new SessionBudget(100);
    const report = (
      ctx: ExtensionContext,
      message: string,
      level: "info" | "error"
    ) => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, level);
      } else {
        pi.sendMessage(
          { customType: "sift-status", content: message, display: true },
          { triggerTurn: false }
        );
      }
    };

    pi.on("session_start", () => {
      enabled = env.PI_SIFT_ENABLED === "1";
      budget = new SessionBudget(100);
    });

    pi.registerTool({
      name: "sift_files",
      label: "Sift Files",
      description:
        "Send workspace file contents to TypeSafe for paid relevance judgments. Requires explicit session opt-in; judgments are advisory, never authorization.",
      promptSnippet:
        "Use session-enabled TypeSafe Sift only to rank explicit candidate files before reading them",
      promptGuidelines: [
        "Use only after the user enables Sift for this session. Treat probabilities as advisory and never as authorization for an action.",
      ],
      parameters,
      async execute(_id, params, signal, _update, ctx) {
        if (!enabled) {
          throw new Error(
            "Sift is disabled; the user must run /sift enable first"
          );
        }
        const credential = await store.resolve();
        const client = createClient(credential.apiKey);
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
            `sift ${args.paths.length} file${args.paths.length === 1 ? "" : "s"}`
          ),
          0,
          0
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
      description: "Manage TypeSafe Sift authentication and session consent",
      getArgumentCompletions(prefix) {
        return ACTIONS.filter((action) => action.startsWith(prefix)).map(
          (action) => ({ value: action, label: action })
        );
      },
      handler: async (raw, ctx) => {
        const action = raw.trim() || "status";
        if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
          report(
            ctx,
            "Usage: /sift [login|logout|status|enable|disable]",
            "error"
          );
          return;
        }
        if (action === "status") {
          report(ctx, await statusText(enabled, budget, store), "info");
          return;
        }
        if (action === "disable") {
          enabled = false;
          report(ctx, "Sift disabled for future calls.", "info");
          return;
        }
        if (action === "logout") {
          await store.clear();
          enabled = false;
          const environmentRemains = env.TYPESAFE_API_KEY !== undefined;
          report(
            ctx,
            `Stored Sift credential cleared; Sift disabled.${environmentRemains ? " TYPESAFE_API_KEY remains and takes precedence." : ""}`,
            "info"
          );
          return;
        }
        if (action === "enable") {
          const credential = await store.status();
          if (!credential.usable) {
            report(
              ctx,
              "Sift needs a usable TypeSafe credential. Run /sift login or set TYPESAFE_API_KEY.",
              "error"
            );
            return;
          }
          if (!ctx.hasUI || ctx.mode !== "tui") {
            report(
              ctx,
              "Noninteractive enablement requires PI_SIFT_ENABLED=1; restart the session with that environment opt-in.",
              "error"
            );
            return;
          }
          const confirmed = await ctx.ui.confirm(
            "Enable TypeSafe Sift?",
            "Selected file contents will leave this machine for paid TypeSafe Jev judgments. Secret detection is incomplete. Enable for this session?"
          );
          if (!confirmed) {
            report(ctx, "Sift remains disabled.", "info");
            return;
          }
          enabled = true;
          report(ctx, "Sift enabled for this session.", "info");
          return;
        }
        const current = await store.status();
        if (current.source === "environment") {
          report(
            ctx,
            "TYPESAFE_API_KEY takes precedence; stored authentication was not changed.",
            "info"
          );
          return;
        }
        if (
          !ctx.hasUI ||
          ctx.mode !== "tui" ||
          typeof ctx.ui.custom !== "function"
        ) {
          report(
            ctx,
            "Secure login requires interactive TUI; set TYPESAFE_API_KEY for headless use.",
            "error"
          );
          return;
        }
        const key = await readSecret(ctx);
        if (key === undefined) {
          report(
            ctx,
            "Sift login cancelled; authentication unchanged.",
            "info"
          );
          return;
        }
        const normalizedKey = key.trim();
        if (
          normalizedKey.length < 16 ||
          normalizedKey.length > 512 ||
          !PRINTABLE_KEY.test(normalizedKey)
        ) {
          report(
            ctx,
            "TypeSafe credential is invalid; authentication unchanged.",
            "error"
          );
          return;
        }
        try {
          const verifier = createClient(normalizedKey);
          await verifier.judge(
            "Credential verification request",
            "verification.txt",
            "Synthetic credential verification; no workspace content."
          );
          await store.save(normalizedKey);
          report(
            ctx,
            "TypeSafe credential verified and saved securely.",
            "info"
          );
        } catch (error) {
          const category = safeLoginFailureCategory(error);
          report(
            ctx,
            `TypeSafe credential verification failed (${category}); authentication unchanged.`,
            "error"
          );
        }
      },
    });
  };
}

function safeLoginFailureCategory(error: unknown): JevFailureCategory {
  return error instanceof JevError ? error.category : "connection";
}

async function statusText(
  enabled: boolean,
  budget: SessionBudget,
  store: Store
): Promise<string> {
  const credential = await store.status();
  const reason = "reason" in credential ? ` (${credential.reason})` : "";
  return `Sift ${enabled ? "enabled" : "disabled"}; credential=${credential.source}${credential.usable ? ":usable" : `:unusable${reason}`}; attempted=${budget.attempted}, remaining=${budget.limit - budget.attempted}; model=${JEV_MODEL}; endpoint=${JEV_ENDPOINT}; secret detection is incomplete.`;
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
class MaskedKeyInput extends Input {
  override handleInput(data: string): void {
    super.handleInput(data);
    if (this.getValue().length > 512) {
      this.setValue(this.getValue().slice(0, 512));
    }
  }
  override render(width: number): string[] {
    const usable = Math.max(1, Math.min(64, width));
    const count = Math.min(this.getValue().length, usable - 1);
    return [
      `${"•".repeat(count)}${this.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[27m`,
    ];
  }
}
function hiddenInput(ctx: ExtensionContext): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((_tui, _theme, _keys, done) => {
    const input = new MaskedKeyInput();
    input.onSubmit = (value) => done(value);
    input.onEscape = () => done(undefined);
    return input;
  });
}

export default createSiftExtension();
