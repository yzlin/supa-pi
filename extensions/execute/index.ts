import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
  EXECUTE_COMMAND_NAME,
  EXECUTE_INVOCATION_PREAMBLE,
  EXECUTE_SYNTHESIS_MESSAGE,
  SPEC_STATUS_MESSAGE_TYPE,
  TO_SPEC_ACCEPTED_NOTE,
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
import { registerExecutionLedger } from "./runtime";
import { renderSpecStatus, SPECS_DIR, validSlug } from "./spec-log";

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

export default function executeExtension(pi: ExtensionAPI): void {
  const authorize = registerExecutionLedger(pi);
  pi.registerCommand(EXECUTE_COMMAND_NAME, {
    description:
      "Execute a plan with blocking subagents and main verification: /execute [plan]",
    handler(args, ctx) {
      const explicitPlan = (args ?? "").trim();
      const plan = explicitPlan || getLastExecutionBriefFromSession(ctx);
      const packet = plan
        ? buildPlanInvocationMessage(plan)
        : EXECUTE_SYNTHESIS_MESSAGE;
      const message = `${packet}\n\nExecution checkpoint invocationId: ${authorize(ctx)}`;

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return Promise.resolve();
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Queued /execute as a follow-up", "info");
      return Promise.resolve();
    },
  });
  pi.registerCommand(TO_SPEC_COMMAND_NAME, {
    description: TO_SPEC_COMMAND_DESCRIPTION,
    handler(args, ctx) {
      const input = (args ?? "").trim();
      const [slug] = input.split(/\s+/);
      const instructions = input.slice(slug.length).trim();
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
      if (slug && existsSync(join(ctx.cwd, SPECS_DIR, `${slug}.log.jsonl`))) {
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
