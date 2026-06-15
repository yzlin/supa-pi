/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Provides both:
 * - /handoff command: user types `/handoff <goal>`
 * - handoff tool: agent can call when user explicitly requests a handoff
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff -model anthropic/claude-haiku-4-5 check other places that need this fix
 *
 * The generated handoff document is saved to the OS temp directory and included
 * in the new-session prompt for immediate use.
 *
 * Credits: This extension was originally developed by @pasky. Modified and enhanced by @yzlin.
 */

import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type Api,
  complete,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  BorderedLoader,
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getModelAuthOrThrow } from "./llm-auth";

const TOP_LEVEL_REGEX_1 = /(?:^|\s)-model\s+(\S+)/;

const CONTEXT_SUMMARY_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused handoff document that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Includes a "Suggested Skills" section naming skills the next agent should invoke, if any are relevant
5. Is self-contained enough for the new thread to proceed, but references existing artifacts instead of duplicating them

Rules:
- Redact sensitive information, including API keys, passwords, tokens, secrets, and personally identifiable information, unless a local file or session path is necessary for continuation.
- Do not duplicate content already captured in PRDs, plans, ADRs, issues, commits, or diffs. Reference those artifacts by path or URL.
- If a detail is uncertain, say so explicitly.
- Be concise but include all necessary context.
- Do not include any preamble like "Here's the handoff" - just output the document itself.

Example output format:
# Handoff

## Focus
[Clear description of what to do next based on user's goal]

## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

## Files and Artifacts
- path/to/file1.ts — why it matters
- path/to/file2.ts — why it matters

## Suggested Skills
- skill-name — why it helps

## Next Steps
- Step 1
- Step 2

## Open Questions / Risks
- Risk or question, if any`;

/**
 * Generate a context summary by asking an LLM to distill the conversation
 * into a focused prompt for a new session.
 *
 * @returns The generated summary text, or null if aborted.
 */
async function generateContextSummary(
  model: Model<Api>,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  messages: AgentMessage[],
  goal: string,
  signal?: AbortSignal
): Promise<string | null> {
  const conversationText = serializeConversation(convertToLlm(messages));

  const userMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
      },
    ],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { systemPrompt: CONTEXT_SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey, headers, signal }
  );

  if (response.stopReason === "aborted") {
    return null;
  }

  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function buildHandoffDocument(
  goal: string,
  body: string,
  parentSession: string | undefined
): string {
  const metadata = [
    `Generated: ${new Date().toISOString()}`,
    `Goal: ${goal}`,
    parentSession ? `Parent session: ${parentSession}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return `${metadata.join("\n")}\n\n${body.trim()}\n`;
}

async function buildHandoffDocumentPath(): Promise<string> {
  const handoffDir = await mkdtemp(join(tmpdir(), "pi-handoff-"));
  await chmod(handoffDir, 0o700);

  return join(handoffDir, "handoff.md");
}

async function writeHandoffDocument(document: string): Promise<string> {
  const handoffPath = await buildHandoffDocumentPath();
  await writeFile(handoffPath, document, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  return handoffPath;
}

function hasNumericTimestamp(
  message: unknown
): message is { timestamp: number } {
  return (
    typeof message === "object" &&
    message !== null &&
    "timestamp" in message &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
  );
}

interface SessionManagerWithNewSession {
  newSession(options: { parentSession: string | undefined }): void;
}

function onSessionSwitch(pi: ExtensionAPI, listener: () => void): void {
  const on = pi.on as unknown as (
    event: "session_switch",
    handler: () => void
  ) => void;

  on("session_switch", listener);
}

function buildHandoffPrompt(
  goal: string,
  handoffPath: string,
  parentSession: string | undefined
): string {
  const parentContext = parentSession
    ? `/skill:session-query\n\n**Parent session:** \`${parentSession}\`\n\n`
    : "";

  return `${goal}\n\n${parentContext}**Handoff document:** \`${handoffPath}\`\n\nRead the handoff document first, then continue with the goal above.`;
}

interface HandoffOptions {
  model?: string;
}

/**
 * Apply -model options after a session switch.
 * For -model, applies the model directly.
 */
async function applyHandoffOptions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options?: HandoffOptions
): Promise<void> {
  if (!options) {
    return;
  }

  if (options.model) {
    // Parse "provider/modelId" format
    const slashIdx = options.model.indexOf("/");
    if (slashIdx > 0) {
      const provider = options.model.slice(0, slashIdx);
      const modelId = options.model.slice(slashIdx + 1);
      const model = ctx.modelRegistry.find(provider, modelId);
      if (model) {
        await pi.setModel(model);
      } else if (ctx.hasUI) {
        ctx.ui.notify(`Handoff: unknown model ${options.model}`, "warning");
      }
    } else if (ctx.hasUI) {
      ctx.ui.notify(
        `Handoff: invalid model format "${options.model}", expected provider/modelId`,
        "warning"
      );
    }
  }
}

/**
 * Core handoff logic. Returns an error string on failure, or undefined on success.
 */
async function performHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  goal: string,
  _pendingHandoff: {
    prompt: string;
    parentSession: string | undefined;
    options?: HandoffOptions;
  } | null,
  setPendingHandoff: (
    v: {
      prompt: string;
      parentSession: string | undefined;
      options?: HandoffOptions;
    } | null
  ) => void,
  fromTool = false,
  options?: HandoffOptions
): Promise<string | undefined> {
  if (!ctx.hasUI) {
    return "Handoff requires interactive mode.";
  }

  if (!ctx.model) {
    return "No model selected.";
  }

  const branch = ctx.sessionManager.getBranch();
  const messages = branch
    .filter(
      (entry): entry is SessionEntry & { type: "message" } =>
        entry.type === "message"
    )
    .map((entry) => entry.message);

  if (messages.length === 0) {
    return "No conversation to hand off.";
  }

  const currentSessionFile = ctx.sessionManager.getSessionFile();

  // Generate the handoff document with loader UI
  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(
      tui,
      theme,
      "Generating handoff document..."
    );
    loader.onAbort = () => done(null);

    const doGenerate = async () => {
      const model = ctx.model as Model<Api>;
      const { apiKey, headers } = await getModelAuthOrThrow(
        ctx.modelRegistry,
        model
      );
      return generateContextSummary(
        model,
        apiKey,
        headers,
        messages,
        goal,
        loader.signal
      );
    };

    doGenerate()
      .then(done)
      .catch((err) => {
        console.error("Handoff generation failed:", err);
        done(null);
      });

    return loader;
  });

  if (result === null) {
    return "Handoff cancelled.";
  }

  const handoffDocument = buildHandoffDocument(
    goal,
    result,
    currentSessionFile
  );
  let handoffPath: string;
  try {
    handoffPath = await writeHandoffDocument(handoffDocument);
  } catch (err) {
    console.error("Handoff document write failed:", err);
    return "Handoff document write failed.";
  }

  // Build the final prompt with user's goal first for easy identification.
  const finalPrompt = buildHandoffPrompt(goal, handoffPath, currentSessionFile);

  if (!fromTool && "newSession" in ctx) {
    // Command path: full reset via ctx.newSession()
    const cmdCtx = ctx as ExtensionCommandContext;
    const newSessionResult = await cmdCtx.newSession({
      parentSession: currentSessionFile,
    });
    if (newSessionResult.cancelled) {
      return;
    }
    await applyHandoffOptions(pi, ctx, options);
    pi.sendUserMessage(finalPrompt);
  } else {
    // Tool path: defer session switch to agent_end handler.
    // We can't call ctx.newSession() from tool context (only ExtensionCommandContext
    // has it). Instead, we store the handoff data and let the agent_end handler
    // perform the session switch after the current agent loop completes.
    // The context event handler ensures the LLM only sees new-session messages.
    setPendingHandoff({
      prompt: finalPrompt,
      parentSession: currentSessionFile,
      options,
    });
  }

  return;
}

export default function (pi: ExtensionAPI) {
  // Shared state for tool-path handoff coordination between handlers
  let pendingHandoff: {
    prompt: string;
    parentSession: string | undefined;
    options?: HandoffOptions;
  } | null = null;

  // Timestamp marking when the handoff session switch occurred.
  // Used by the context event handler to filter out pre-handoff messages
  // from agent.state.messages (which aren't cleared by the low-level switch).
  let handoffTimestamp: number | null = null;

  const setPendingHandoff = (
    v: {
      prompt: string;
      parentSession: string | undefined;
      options?: HandoffOptions;
    } | null
  ) => {
    pendingHandoff = v;
  };

  // --- Event handlers for tool-path handoff ---
  //
  // WHY IS THIS SO COMPLICATED?
  //
  // The /handoff command path is simple: it has ExtensionCommandContext with
  // ctx.newSession() which does a full agent state reset (agent.reset() +
  // UI clear + queue reset + event emission). But the tool path only gets
  // ExtensionContext, which lacks newSession().
  //
  // Simpler approaches don't work:
  // - sendUserMessage("/new") doesn't expand slash commands
  // - There's no public API to programmatically invoke commands from tool context
  // - sessionManager.newSession() only switches the session file; it does NOT
  //   clear agent.state.messages, so the LLM would still see the entire old
  //   conversation
  // - We can't call agent.reset() from tool context either
  //
  // The solution uses three coordinated event handlers:
  //
  // 1. agent_end: Defers the session switch until after the agent loop completes.
  //    This ensures the tool_result is recorded in the old session first, and
  //    avoids concurrent _runLoop instances. Uses sessionManager.newSession()
  //    for the file switch, then setTimeout(() => sendUserMessage()) to start
  //    the new session in the next macrotask.
  //
  // 2. context: Filters pre-handoff messages using a timestamp. Since we can't
  //    call agent.reset(), old messages remain in agent.state.messages, but the
  //    context event's transformContext mechanism lets us control what the LLM
  //    actually sees. This is safe because getContextUsage() uses the last
  //    assistant's actual usage data (correct after the first response), and
  //    auto-compaction checks assistant usage tokens rather than the messages
  //    array length.
  //
  // 3. session_switch: Clears the context filter when a proper session switch
  //    occurs (e.g., /new), since those fully reset agent.state.messages and
  //    our filter would incorrectly hide the new session's messages.

  // After the agent loop ends, perform the deferred session switch.
  // At this point:
  // - The tool_result has been recorded in the OLD session
  // - The agent is idle (isStreaming = false)
  // - We can safely switch sessions and start a new prompt
  pi.on("agent_end", (_event, ctx) => {
    if (!pendingHandoff) {
      return;
    }

    const { prompt, parentSession, options } = pendingHandoff;
    pendingHandoff = null;

    // Record timestamp BEFORE switching - all old messages have timestamps
    // before this, all new messages will have timestamps after.
    handoffTimestamp = Date.now();

    // Low-level session switch: creates new session file, resets entries.
    // This does NOT clear agent.state.messages (we handle that via context event).
    (ctx.sessionManager as unknown as SessionManagerWithNewSession).newSession({
      parentSession,
    });

    // Defer sendUserMessage to the next macrotask to ensure the old agent
    // loop's _runLoop cleanup has fully completed (isStreaming reset,
    // runningPrompt resolved). Without this, we'd have two concurrent
    // _runLoop instances with conflicting state.
    setTimeout(async () => {
      await applyHandoffOptions(pi, ctx, options);
      pi.sendUserMessage(prompt);
    }, 0);
  });

  // Before each LLM call, filter out pre-handoff messages.
  // After a tool-path handoff, agent.state.messages still contains all old
  // messages (since we can't call agent.reset()). The context event lets us
  // replace what the LLM sees without affecting agent internals.
  //
  // This is safe because:
  // - getContextUsage() uses the last assistant message's usage data, which
  //   will reflect the small new-session context after the first response
  // - Auto-compaction checks the assistant message's usage tokens, not
  //   agent.state.messages, so won't trigger incorrectly
  // - The session file only contains new-session entries (correct for
  //   token/cost display and session persistence)
  pi.on("context", (event) => {
    if (handoffTimestamp == null) {
      return;
    }
    const ts = handoffTimestamp;

    const newMessages = event.messages.filter(
      (m: unknown) => hasNumericTimestamp(m) && m.timestamp >= ts
    );
    if (newMessages.length > 0) {
      return { messages: newMessages };
    }
    // No messages pass the filter - shouldn't happen in normal flow,
    // but don't break things by returning empty messages
  });

  // When a proper session switch occurs (e.g., /new, tree navigation, /switch),
  // agent.state.messages is fully reset by AgentSession.newSession(). Clear our
  // filter so we don't interfere with the properly-reset state.
  onSessionSwitch(pi, () => {
    handoffTimestamp = null;
  });

  // /handoff command
  pi.registerCommand("handoff", {
    description:
      "Transfer context to a new focused session (-model <provider/id>)",
    handler: async (args, ctx) => {
      // Parse optional -model flags from args
      const options: HandoffOptions = {};
      let remaining = args;

      const modelMatch = remaining.match(TOP_LEVEL_REGEX_1);
      if (modelMatch) {
        options.model = modelMatch[1];
        remaining = remaining.replace(modelMatch[0], " ");
      }

      const goal = remaining.trim();
      if (!goal) {
        ctx.ui.notify("Usage: /handoff [-model <provider/id>] <goal>", "error");
        return;
      }

      const hasOptions = !!options.model;
      const error = await performHandoff(
        pi,
        ctx,
        goal,
        pendingHandoff,
        setPendingHandoff,
        false,
        hasOptions ? options : undefined
      );
      if (error) {
        ctx.ui.notify(error, "error");
      }
    },
  });

  // handoff tool (agent-callable)
  pi.registerTool({
    name: "handoff",
    label: "Handoff",
    description:
      "Transfer context to a new focused session. ONLY use this when the user explicitly asks for a handoff. Provide a goal describing what the new session should focus on.",
    parameters: Type.Object({
      goal: Type.String({ description: "The goal/task for the new session" }),
      mode: Type.Optional(
        Type.String({
          description:
            "Amplike mode name to start the new session with (e.g. 'rush', 'smart', 'deep')",
        })
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model to start the new session with, as provider/modelId (e.g. 'anthropic/claude-haiku-4-5')",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const options: HandoffOptions = {};
      if (params.model) {
        options.model = params.model;
      }
      const hasOptions = !!options.model;
      const error = await performHandoff(
        pi,
        ctx,
        params.goal,
        pendingHandoff,
        setPendingHandoff,
        true,
        hasOptions ? options : undefined
      );
      return {
        content: [
          {
            type: "text",
            text:
              error ??
              "Handoff initiated. The session will switch after the current turn completes.",
          },
        ],
        details: null,
      };
    },
  });
}
