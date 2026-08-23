import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  type AutoRenameConfigState,
  DEFAULT_AUTO_RENAME_CONFIG,
  loadAutoRenameConfig,
} from "./config";
import { generateSessionTitle, type NamingFailureCategory } from "./naming";

type RuntimeContext = ExtensionContext | ExtensionCommandContext;
type OperationKind = "automatic" | "regen";

interface NamingOperation {
  controller: AbortController;
  epoch: number;
  sessionId: string;
  branchGeneration: number;
  previousName: string | undefined;
}

function currentSessionId(ctx: RuntimeContext): string | null {
  const value = ctx.sessionManager.getSessionId();
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizedName(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function messageText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() ? content : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part !== null &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text)
    .join("\n");
  return text.trim() ? text : null;
}

function firstBranchUserText(ctx: RuntimeContext): string | null {
  const entries = ctx.sessionManager.getBranch() as unknown[];
  for (const candidate of entries) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const entry = candidate as {
      role?: unknown;
      content?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    const message = entry.message ?? entry;
    if (message.role !== "user") {
      continue;
    }
    const text = messageText(message.content);
    if (text) {
      return text;
    }
  }
  return null;
}

function notify(
  ctx: RuntimeContext,
  message: string,
  level: "info" | "warning" | "error" = "info"
): boolean {
  if (ctx.hasUI && ctx.ui && typeof ctx.ui.notify === "function") {
    ctx.ui.notify(message, level);
    return true;
  }
  return false;
}

export default function autoRenameExtension(pi: ExtensionAPI): void {
  let configState: AutoRenameConfigState = {
    valid: true,
    source: "defaults",
    config: { ...DEFAULT_AUTO_RENAME_CONFIG },
  };
  let retainedRaw: string | null = null;
  let persistedBranchSource: string | null = null;
  let observedName: string | undefined;
  let inFlight: NamingOperation | null = null;
  let epoch = 0;
  let branchGeneration = 0;
  let warnedInvalid = false;
  let lastFailure: NamingFailureCategory | null = null;
  const completedAutomaticBranches = new Set<string>();

  function debug(label: string): void {
    if (configState.config.debug) {
      console.warn(`auto-rename: ${label}`);
    }
  }

  function warnInvalid(ctx: RuntimeContext): void {
    if (configState.valid || warnedInvalid) {
      return;
    }
    warnedInvalid = true;
    if (
      !notify(
        ctx,
        "Auto-rename disabled: invalid global configuration.",
        "warning"
      )
    ) {
      console.warn("auto-rename: disabled-invalid");
    }
  }

  function warnPersistenceFailure(ctx: RuntimeContext): void {
    if (
      !notify(ctx, "Auto-rename could not save the session name.", "warning")
    ) {
      console.warn("auto-rename: persistence-failed");
    }
  }

  function reloadConfig(ctx: RuntimeContext): void {
    configState = loadAutoRenameConfig();
    warnInvalid(ctx);
    debug("config-reloaded");
  }

  function abortOperation(label: string): void {
    if (inFlight) {
      inFlight.controller.abort();
      inFlight = null;
    }
    epoch += 1;
    debug(label);
  }

  function sourceFor(kind: OperationKind, ctx: RuntimeContext): string | null {
    const source =
      kind === "automatic"
        ? (persistedBranchSource ?? retainedRaw ?? firstBranchUserText(ctx))
        : (retainedRaw ?? persistedBranchSource ?? firstBranchUserText(ctx));
    return source ? source.slice(0, configState.config.maxQueryLength) : null;
  }

  function enabled(): boolean {
    return configState.valid && configState.config.enabled;
  }

  function operationIsCurrent(
    operation: NamingOperation,
    ctx: RuntimeContext
  ): boolean {
    return (
      operation.epoch === epoch &&
      currentSessionId(ctx) === operation.sessionId &&
      branchGeneration === operation.branchGeneration &&
      enabled()
    );
  }

  async function runNaming(
    kind: OperationKind,
    ctx: RuntimeContext
  ): Promise<"started" | "disabled" | "no-session" | "no-source" | "pending"> {
    if (!enabled()) {
      return "disabled";
    }
    if (inFlight) {
      return "pending";
    }

    const sessionId = currentSessionId(ctx);
    if (!sessionId) {
      return "no-session";
    }
    const automatic = kind === "automatic";
    const previousName = normalizedName(pi.getSessionName());
    if (automatic && (previousName || observedName)) {
      return "disabled";
    }

    const source = sourceFor(kind, ctx);
    if (!source) {
      return "no-source";
    }
    const branchKey = `${sessionId}:${branchGeneration}`;
    if (automatic && completedAutomaticBranches.has(branchKey)) {
      return "disabled";
    }

    const operation: NamingOperation = {
      controller: new AbortController(),
      epoch,
      sessionId,
      branchGeneration,
      previousName,
    };
    inFlight = operation;
    debug(`${kind}-started`);

    const result = await generateSessionTitle(
      ctx,
      source,
      sessionId,
      configState.config,
      operation.controller.signal
    );

    if (inFlight === operation) {
      inFlight = null;
    }
    if (!operationIsCurrent(operation, ctx)) {
      debug(`${kind}-stale`);
      return "started";
    }
    const currentName = normalizedName(pi.getSessionName());
    const nameUnchanged = automatic
      ? !(currentName || observedName)
      : currentName === operation.previousName &&
        normalizedName(observedName) === operation.previousName;
    if (!nameUnchanged) {
      debug(`${kind}-name-changed`);
      return "started";
    }

    lastFailure = result.failure ?? null;
    if (result.failure) {
      debug(`failure-${result.failure}`);
    }
    try {
      pi.setSessionName(result.title);
    } catch {
      warnPersistenceFailure(ctx);
      debug(`${kind}-persistence-failed`);
      return "started";
    }
    observedName = result.title;
    if (automatic) {
      completedAutomaticBranches.add(branchKey);
    }
    debug(`${kind}-written`);
    return "started";
  }

  pi.on("session_start", (_event, ctx) => {
    abortOperation("session-start");
    retainedRaw = null;
    persistedBranchSource = firstBranchUserText(ctx);
    observedName = normalizedName(pi.getSessionName());
    completedAutomaticBranches.clear();
    lastFailure = null;
    reloadConfig(ctx);
  });

  pi.on("input", (event) => {
    if (
      retainedRaw === null &&
      event.source !== "extension" &&
      event.text.trim().length > 0
    ) {
      retainedRaw = event.text.slice(0, configState.config.maxQueryLength);
      debug("input-captured");
    }
    return { action: "continue" };
  });

  pi.on("session_info_changed", (event) => {
    observedName = normalizedName(event.name);
    debug("session-info-changed");
  });

  pi.on("agent_settled", (_event, ctx) => {
    runNaming("automatic", ctx).catch(() => {
      abortOperation("automatic-unexpected-error");
    });
  });

  pi.on("session_tree", (_event, ctx) => {
    abortOperation("session-tree");
    branchGeneration += 1;
    retainedRaw = null;
    persistedBranchSource = firstBranchUserText(ctx);
    observedName = normalizedName(pi.getSessionName());
  });

  pi.on("session_shutdown", () => {
    abortOperation("session-shutdown");
    retainedRaw = null;
    persistedBranchSource = null;
    observedName = undefined;
    completedAutomaticBranches.clear();
  });

  function statusText(): string {
    let state = "disabled-invalid";
    if (configState.valid) {
      state = configState.config.enabled ? "enabled" : "disabled";
    }
    const currentName = normalizedName(pi.getSessionName()) ?? "unnamed";
    return [
      `auto-rename: ${state}`,
      `name: ${currentName}`,
      `pending: ${inFlight ? "yes" : "no"}`,
      `maxQueryLength: ${configState.config.maxQueryLength}`,
      `maxNameLength: ${configState.config.maxNameLength}`,
      `timeoutMs: ${configState.config.timeoutMs}`,
      `debug: ${configState.config.debug}`,
      `last failure: ${lastFailure ?? "none"}`,
    ].join("\n");
  }

  pi.registerCommand("auto-rename", {
    description:
      "Show auto-rename status or regenerate the current session name",
    handler: async (args, ctx) => {
      const argument = (args ?? "").trim().toLowerCase();
      if (!argument || argument === "status") {
        reloadConfig(ctx);
        notify(ctx, statusText());
        return;
      }
      if (argument !== "regen") {
        notify(ctx, "Usage: /auto-rename [status|regen]", "warning");
        return;
      }

      const outcome = await runNaming("regen", ctx);
      if (outcome === "disabled") {
        notify(ctx, "Auto-rename is disabled.", "warning");
      } else if (outcome === "pending") {
        notify(ctx, "Auto-rename is already pending.", "warning");
      } else if (outcome === "no-session") {
        notify(ctx, "No current session is available to rename.", "error");
      } else if (outcome === "no-source") {
        notify(
          ctx,
          "No user request is available to name this session.",
          "error"
        );
      }
    },
  });
}
