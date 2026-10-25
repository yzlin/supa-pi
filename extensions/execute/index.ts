import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
  EXECUTE_CANCELLED_MESSAGE,
  EXECUTE_COMMAND_NAME,
  EXECUTE_DRAFT_MESSAGE,
  EXECUTE_DRAFT_NEW_SPEC_LABEL,
  EXECUTE_DRAFT_SOURCE_LABEL,
  EXECUTE_INVOCATION_PREAMBLE,
  EXECUTE_STALE_SPEC_TITLE,
  EXECUTE_SYNTHESIS_MESSAGE,
  EXECUTE_USE_SPEC_LABEL,
  SPEC_STATUS_MESSAGE_TYPE,
  TO_SPEC_ACCEPTED_NOTE,
  TO_SPEC_CLASSIFIER_USAGE,
  TO_SPEC_COMMAND_DESCRIPTION,
  TO_SPEC_COMMAND_NAME,
  TO_SPEC_DERIVE_SLUG,
  TO_SPEC_EXISTING_LABEL,
  TO_SPEC_INVALID_SLUG,
  TO_SPEC_INVOCATION_PREAMBLE,
  TO_SPEC_OVERWRITE_NOTE,
  TO_SPEC_QUEUED_MESSAGE,
  TO_SPEC_SLUG_LABEL,
} from "./constants";
import { isLedgerComplete, restoreLedger } from "./ledger";
import { registerExecutionLedger } from "./runtime";
import type { ExecutionLedger } from "./schema";
import { latestDraftedSpec, specLogAccepted } from "./spec-draft";
import { renderSpecStatus, SPECS_DIR, validSlug } from "./spec-log";
import {
  SpecReviewConfigStore,
  selectSpecReviewModel,
  type SpecReviewModel,
} from "./spec-review";

interface MessageLike {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

const EXECUTION_BRIEF_TITLE = "Execution Brief";
const EXECUTION_BRIEF_REQUIRED_SECTIONS = [
  "Execution Scope",
  "Plan",
  "Done Criteria",
  "Verification",
  "Out of Scope",
] as const;

function buildPlanInvocationMessage(args: string): string {
  const plan = args.trim();
  return `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\n${plan}\n</plan>`;
}

function extractTextContent(content: MessageLike["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) =>
      part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
    .trim();
}

function hasMarkdownHeading(
  text: string,
  heading: string,
  level: number,
): boolean {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^#{${level}}\\s+${escapedHeading}\\s*$`, "im").test(text);
}

function isExecutionBrief(text: string): boolean {
  return (
    hasMarkdownHeading(text, EXECUTION_BRIEF_TITLE, 1) &&
    EXECUTION_BRIEF_REQUIRED_SECTIONS.every((section) =>
      hasMarkdownHeading(text, section, 2),
    )
  );
}

function legacyBarePacket(ctx: ExtensionCommandContext): string {
  const brief = getLastExecutionBriefFromSession(ctx);
  return brief ? buildPlanInvocationMessage(brief) : EXECUTE_SYNTHESIS_MESSAGE;
}

function draftPacket(ctx: ExtensionCommandContext): string {
  const brief = getLastExecutionBriefFromSession(ctx);
  return brief
    ? `${EXECUTE_DRAFT_MESSAGE}\n${EXECUTE_DRAFT_SOURCE_LABEL}\n\n<execution-brief>\n${brief}\n</execution-brief>`
    : EXECUTE_DRAFT_MESSAGE;
}

// Bare /execute always runs a Spec except for an unfinished non-Spec plan.
async function resolveBarePacket(
  ctx: ExtensionCommandContext,
): Promise<string | null> {
  const branch = ctx.sessionManager.getBranch();
  let ledger: ExecutionLedger | null;
  try {
    ledger = restoreLedger(branch, ctx.sessionManager.getSessionId());
  } catch {
    // The runtime reports the unreadable ledger; keep the pre-Spec packet.
    return legacyBarePacket(ctx);
  }
  if (ledger?.plan && !isLedgerComplete(ledger)) {
    return ledger.specPath
      ? buildPlanInvocationMessage(`@${ledger.specPath}`)
      : legacyBarePacket(ctx);
  }
  const drafted = latestDraftedSpec(branch, ctx.cwd);
  if (!drafted) {
    return draftPacket(ctx);
  }
  const specPath = `${SPECS_DIR}/${drafted.slug}.md`;
  const useSpec = buildPlanInvocationMessage(`@${specPath}`);
  if (!drafted.laterUserMessage) {
    return useSpec;
  }
  if (!ctx.hasUI) {
    return draftPacket(ctx);
  }
  const useLabel = `${EXECUTE_USE_SPEC_LABEL}${specPath}`;
  const choice = await ctx.ui.select(EXECUTE_STALE_SPEC_TITLE, [
    useLabel,
    EXECUTE_DRAFT_NEW_SPEC_LABEL,
  ]);
  if (choice === useLabel) {
    return useSpec;
  }
  return choice === EXECUTE_DRAFT_NEW_SPEC_LABEL ? draftPacket(ctx) : null;
}

function getLastExecutionBriefFromSession(
  ctx: ExtensionCommandContext,
): string {
  const branch = ctx.sessionManager.getBranch();

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "message") {
      continue;
    }

    const message = entry.message as MessageLike;
    if (message.role === "user") {
      return "";
    }

    if (message.role !== "assistant") {
      continue;
    }

    const text = extractTextContent(message.content);
    if (text && isExecutionBrief(text)) {
      return text;
    }
  }

  return "";
}

async function selectModelOrError(
  ctx: ExtensionCommandContext,
): Promise<{ model?: SpecReviewModel; error?: string }> {
  try {
    return { model: await selectSpecReviewModel(ctx.modelRegistry) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// Consent is global and owner-only; headless sessions only consume it.
async function specReviewClassifierCommand(
  action: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const store = new SpecReviewConfigStore();
  if (action === "disable") {
    await store.save(false);
    ctx.ui.notify("Spec review classifier disabled globally.", "info");
    return;
  }
  const { model, error: registryError } = await selectModelOrError(ctx);
  const name = model ? `${model.provider}/${model.id}` : "none";
  if (!action) {
    let state: string;
    try {
      state = (await store.load()) ? "enabled" : "disabled";
    } catch (error) {
      state = `disabled (${error instanceof Error ? error.message : String(error)})`;
    }
    const modelText = registryError
      ? `${name} (registry error: ${registryError})`
      : name;
    ctx.ui.notify(
      `Spec review classifier ${state}; model=${modelText}`,
      "info",
    );
    return;
  }
  if (action !== "enable") {
    ctx.ui.notify(TO_SPEC_CLASSIFIER_USAGE, "error");
    return;
  }
  if (registryError) {
    ctx.ui.notify(
      `Spec review classifier registry failed: ${registryError}; Spec review classifier stays disabled.`,
      "error",
    );
    return;
  }
  if (!model) {
    ctx.ui.notify(
      "No credentialed Jev classifier is available; Spec review classifier stays disabled.",
      "error",
    );
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "Enabling the Spec review classifier requires an interactive session.",
      "error",
    );
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "Enable the Spec review classifier globally?",
    `Before Spec-backed /execute accepts an unaccepted Spec, its full text will leave this machine for a paid classifier judgment through ${name}. Enable for this and future sessions?`,
  );
  if (!confirmed) {
    ctx.ui.notify("Spec review classifier remains disabled.", "info");
    return;
  }
  await store.save(true);
  ctx.ui.notify("Spec review classifier enabled globally.", "info");
}

export default function executeExtension(pi: ExtensionAPI): void {
  const authorize = registerExecutionLedger(pi);
  pi.registerCommand(EXECUTE_COMMAND_NAME, {
    description:
      "Execute a plan with blocking subagents and main verification: /execute [plan]",
    async handler(args, ctx) {
      const explicitPlan = (args ?? "").trim();
      const packet = explicitPlan
        ? buildPlanInvocationMessage(explicitPlan)
        : await resolveBarePacket(ctx);
      if (!packet) {
        ctx.ui.notify(EXECUTE_CANCELLED_MESSAGE, "info");
        return;
      }
      const message = `${packet}\n\nExecution checkpoint invocationId: ${authorize(ctx)}`;

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Queued /execute as a follow-up", "info");
    },
  });
  pi.registerCommand(TO_SPEC_COMMAND_NAME, {
    description: TO_SPEC_COMMAND_DESCRIPTION,
    handler(args, ctx) {
      const input = (args ?? "").trim();
      const [slug] = input.split(/\s+/);
      const instructions = input.slice(slug.length).trim();
      if (slug === "classifier") {
        return specReviewClassifierCommand(instructions, ctx);
      }
      if (slug === "status") {
        pi.sendMessage({
          customType: SPEC_STATUS_MESSAGE_TYPE,
          content: renderSpecStatus(ctx.cwd, instructions || undefined),
          display: true,
        });
        return Promise.resolve();
      }
      if (slug && !validSlug(slug)) {
        ctx.ui.notify(TO_SPEC_INVALID_SLUG, "error");
        return Promise.resolve();
      }
      // Only an accepted event accepts; a corrupt log fails closed as accepted.
      if (slug && specLogAccepted(ctx.cwd, slug)) {
        ctx.ui.notify(`Spec ${slug} ${TO_SPEC_ACCEPTED_NOTE}`, "error");
        return Promise.resolve();
      }
      const packet = [
        TO_SPEC_INVOCATION_PREAMBLE,
        `${TO_SPEC_SLUG_LABEL}${slug || TO_SPEC_DERIVE_SLUG}`,
      ];
      if (slug && existsSync(join(ctx.cwd, SPECS_DIR, `${slug}.md`))) {
        packet.push(
          `${TO_SPEC_EXISTING_LABEL}${SPECS_DIR}/${slug}.md${TO_SPEC_OVERWRITE_NOTE}`,
        );
      }
      if (instructions) {
        packet.push(instructions);
      }
      const message = packet.join("\n\n");
      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return Promise.resolve();
      }
      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify(TO_SPEC_QUEUED_MESSAGE, "info");
      return Promise.resolve();
    },
  });
}
