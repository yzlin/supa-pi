import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { EXECUTE_COMMAND_NAME, EXECUTE_PROMPT } from "./constants";
import { registerExecuteCheckpointTool } from "./tools";

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

function buildExecuteCommandMessage(args: string): string {
  const plan = args.trim();
  return plan
    ? `${EXECUTE_PROMPT}\n\n<plan>\n${plan}\n</plan>`
    : EXECUTE_PROMPT;
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
      part?.type === "text" && typeof part.text === "string" ? [part.text] : []
    )
    .join("\n")
    .trim();
}

function hasMarkdownHeading(
  text: string,
  heading: string,
  level: number
): boolean {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^#{${level}}\\s+${escapedHeading}\\s*$`, "im").test(text);
}

function isExecutionBrief(text: string): boolean {
  return (
    hasMarkdownHeading(text, EXECUTION_BRIEF_TITLE, 1) &&
    EXECUTION_BRIEF_REQUIRED_SECTIONS.every((section) =>
      hasMarkdownHeading(text, section, 2)
    )
  );
}

function buildExecutionBriefSynthesisMessage(): string {
  const requiredHeadings = [
    `- # ${EXECUTION_BRIEF_TITLE}`,
    ...EXECUTION_BRIEF_REQUIRED_SECTIONS.map((section) => `- ## ${section}`),
  ].join("\n");

  return `Synthesize a new Execution Brief from the current session context. You may inspect the repo read-only if needed. Do not implement anything yet. If material ambiguity exists, ask concise clarifying questions and emit no executable brief.\n\nThe brief must include these exact markdown sections:\n${requiredHeadings}`;
}

function getLastExecutionBriefFromSession(
  ctx: ExtensionCommandContext
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
  registerExecuteCheckpointTool(pi);

  pi.registerCommand(EXECUTE_COMMAND_NAME, {
    description:
      "Execute a plan via main-session task orchestration: /execute [plan]",
    handler: (args, ctx) => {
      const explicitPlan = (args ?? "").trim();
      const task = explicitPlan || getLastExecutionBriefFromSession(ctx);
      const message = task
        ? buildExecuteCommandMessage(task)
        : buildExecutionBriefSynthesisMessage();

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return Promise.resolve();
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Queued /execute as a follow-up", "info");
      return Promise.resolve();
    },
  });
}
