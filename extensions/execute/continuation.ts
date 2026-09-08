import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { ExecuteCheckpoint } from "./checkpoint";

const MAX_CONTINUATION_NUDGES = 2;
const MESSAGE_TYPE = "execute-continuation";

interface Invocation {
  id: string;
  cwd: string;
  sessionId: string;
  canonicalPlanHash?: string;
  nudgesUsed: number;
}

function sameContext(invocation: Invocation, ctx: ExtensionContext): boolean {
  return (
    invocation.cwd === ctx.cwd &&
    invocation.sessionId === ctx.sessionManager.getSessionId()
  );
}

function hasRunnableContinuation(checkpoint: ExecuteCheckpoint): boolean {
  const continuation = checkpoint.continuation;
  if (
    checkpoint.status !== "active" ||
    !continuation ||
    continuation.recoveryRounds >= 2
  ) {
    return false;
  }
  const tasks = new Map(checkpoint.tasks.map((task) => [task.id, task]));
  const next = tasks.get(continuation.taskId);
  return (
    tasks.size === checkpoint.tasks.length &&
    checkpoint.tasks.every((task) =>
      ["pending", "in_progress", "completed"].includes(task.status)
    ) &&
    !!next &&
    ["pending", "in_progress"].includes(next.status) &&
    (next.blockedBy ?? []).every((id) => tasks.get(id)?.status === "completed")
  );
}

export function registerExecuteContinuation(pi: ExtensionAPI) {
  let pending: { message: string; invocation: Invocation } | undefined;
  let active: Invocation | undefined;
  let ticket:
    | { checkpoint: ExecuteCheckpoint; signal: AbortSignal; settled: boolean }
    | undefined;
  let removeAbortListener: (() => void) | undefined;
  const runningTools = new Set<string>();
  let overlappingTools = false;

  function clearTicket() {
    removeAbortListener?.();
    removeAbortListener = undefined;
    ticket = undefined;
  }
  function reset() {
    clearTicket();
    pending = undefined;
    active = undefined;
  }

  pi.on("input", (event) => {
    if (event.source !== "extension" || event.text !== pending?.message) {
      reset();
    }
  });
  pi.on("message_start", ({ message }, ctx) => {
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      const start = pending;
      reset();
      if (
        start &&
        start.message === text &&
        sameContext(start.invocation, ctx)
      ) {
        active = start.invocation;
      }
    } else if (
      message.role === "custom" &&
      (message.customType !== MESSAGE_TYPE ||
        !message.details ||
        typeof message.details !== "object" ||
        !("invocationId" in message.details) ||
        message.details.invocationId !== active?.id)
    ) {
      reset();
    }
  });
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_before_tree", reset);
  pi.on("session_before_compact", reset);
  pi.on("user_bash", reset);
  pi.on("tool_execution_start", (event) => {
    clearTicket();
    overlappingTools = runningTools.size > 0;
    runningTools.add(event.toolCallId);
  });
  pi.on("tool_execution_end", (event) => {
    runningTools.delete(event.toolCallId);
    if (event.isError) {
      reset();
    } else if (event.toolName !== "execute_checkpoint") {
      clearTicket();
    }
  });
  pi.on("agent_end", (event, ctx) => {
    const last = event.messages.at(-1);
    if (
      event.messages.some(
        (message) =>
          (message.role === "assistant" &&
            ["error", "aborted"].includes(message.stopReason)) ||
          (message.role === "toolResult" && message.isError)
      )
    ) {
      reset();
      return;
    }
    if (
      !(active && ticket) ||
      runningTools.size > 0 ||
      !sameContext(active, ctx) ||
      ctx.signal !== ticket.signal ||
      ticket.signal.aborted ||
      last?.role !== "assistant" ||
      last.stopReason !== "stop"
    ) {
      clearTicket();
      return;
    }
    ticket = { ...ticket, settled: true };
  });
  // Do not queue from agent_end: Pi may still retry/compact, and Esc can still abort that run.
  pi.on("agent_settled", (_event, ctx) => {
    const ready = ticket;
    clearTicket();
    if (
      !(active && ready?.settled) ||
      ready.signal.aborted ||
      !sameContext(active, ctx) ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      active.nudgesUsed >= MAX_CONTINUATION_NUDGES
    ) {
      return;
    }
    active = { ...active, nudgesUsed: active.nudgesUsed + 1 };
    pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: `Continue the current /execute plan (${active.canonicalPlanHash}) from its reconciled checkpoint. Runnable task: ${ready.checkpoint.continuation!.taskId}. Use independent verification for evidence/process recovery; invalidResult is never proof. Preserve original-slice recovery budgets. Do not repeat mutations to manufacture RED. Stop and checkpoint any pause, blocker, cancellation, completion or exhausted budget. This is bounded continuation ${active.nudgesUsed}/${MAX_CONTINUATION_NUDGES}, not new authorization.`,
        display: true,
        details: { invocationId: active.id },
      },
      { triggerTurn: true, deliverAs: "followUp" }
    );
  });

  return {
    start(message: string, ctx: ExtensionContext) {
      reset();
      pending = {
        message,
        invocation: {
          id: randomUUID(),
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
          nudgesUsed: 0,
        },
      };
    },
    observe(
      canonicalPlanHash: string,
      ctx: ExtensionContext,
      checkpoint?: ExecuteCheckpoint,
      signal?: AbortSignal
    ) {
      clearTicket();
      if (!active) {
        return;
      }
      if (
        !sameContext(active, ctx) ||
        (active.canonicalPlanHash &&
          active.canonicalPlanHash !== canonicalPlanHash)
      ) {
        reset();
        return;
      }
      active = { ...active, canonicalPlanHash };
      if (
        checkpoint &&
        (checkpoint.status !== "active" ||
          (checkpoint.continuation?.recoveryRounds ?? 0) >= 2)
      ) {
        reset();
        return;
      }
      if (
        !(checkpoint && hasRunnableContinuation(checkpoint)) ||
        overlappingTools ||
        !signal ||
        signal.aborted ||
        active.nudgesUsed >= MAX_CONTINUATION_NUDGES
      ) {
        return;
      }
      ticket = { checkpoint, signal, settled: false };
      signal.addEventListener("abort", reset, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", reset);
    },
  };
}
