import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import {
  bindCall,
  dispatchPrefix,
  emptyLedger,
  interruptLedger,
  isLedgerComplete,
  LEDGER_ENTRY_TYPE,
  recordReport,
  restoreLedger,
  transitionLedger,
} from "./ledger";
import {
  CheckpointOutputSchema,
  CheckpointParametersSchema,
  CheckpointSchema,
  type ExecutionLedger,
  WorkerReportSchema,
} from "./schema";

interface BoundCall {
  sessionId: string;
  invocationId: string;
  assignmentId: string;
  attemptId: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Execution checkpoint failed";
}

function readEnvelope(input: unknown): { runId: string; report: unknown } {
  if (
    !input ||
    typeof input !== "object" ||
    !("runId" in input) ||
    typeof input.runId !== "string" ||
    !input.runId.trim() ||
    !("structuredOutput" in input)
  ) {
    throw new Error("Subagent returned no run-bound structuredOutput object");
  }
  return { runId: input.runId, report: input.structuredOutput };
}

export function registerExecutionLedger(
  pi: ExtensionAPI,
): (ctx: ExtensionContext) => string {
  let ledger: ExecutionLedger | null = null;
  let loadError: string | null = null;
  const authorizations = new Map<string, string>();
  const calls = new Map<string, BoundCall>();
  let stopWatchingAbort: (() => void) | undefined;

  function clearAbortWatcher(): void {
    stopWatchingAbort?.();
    stopWatchingAbort = undefined;
  }

  function persist(next: ExecutionLedger): void {
    pi.appendEntry(LEDGER_ENTRY_TYPE, structuredClone(next));
    ledger = next;
  }

  function revoke(reason: string): void {
    authorizations.clear();
    calls.clear();
    if (ledger) {
      persist(interruptLedger(ledger, reason));
    }
  }

  function reload(ctx: ExtensionContext): void {
    clearAbortWatcher();
    authorizations.clear();
    calls.clear();
    ledger = null;
    loadError = null;
    try {
      ledger = restoreLedger(
        ctx.sessionManager.getBranch(),
        ctx.sessionManager.getSessionId(),
      );
    } catch (error) {
      loadError = errorMessage(error);
      ctx.ui.notify(loadError, "error");
    }
  }

  pi.on("session_start", (_event, ctx) => {
    reload(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    reload(ctx);
  });
  pi.on("session_shutdown", () => {
    clearAbortWatcher();
    revoke(
      "Session ended; explicit /execute and current-state reconciliation required",
    );
  });
  pi.on("agent_start", (_event, ctx) => {
    clearAbortWatcher();
    // Native abort skips agent_before_settle, and ctx.signal is gone by
    // agent_settled. Observe the public run signal while it is still owned.
    const signal = ctx.signal;
    if (!signal) {
      return;
    }
    const onAbort = () => {
      revoke(
        "Parent interrupted; explicit /execute and current-state reconciliation required",
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    stopWatchingAbort = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
    }
  });
  // Settlement alone is not an interruption: normal continuation retains its packet.
  pi.on("agent_settled", () => {
    clearAbortWatcher();
  });
  pi.on("agent_before_settle", (event) => {
    if (event.outcome === "aborted" || event.outcome === "error") {
      revoke(
        "Parent interrupted; explicit /execute and current-state reconciliation required",
      );
    }
  });

  pi.registerTool({
    name: "execute_checkpoint",
    label: "Execution checkpoint",
    description:
      "Main-session execution ledger only. Requires the invocationId from explicit /execute. accept one canonical plan; start returns an exact subagent task prefix; inspect; verify with independent main evidence; block; repair (max two per lineage); stop. Child claims never complete assignments.",
    parameters: CheckpointParametersSchema,
    outputSchema: CheckpointOutputSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (loadError) {
        throw new Error(loadError);
      }
      if (signal?.aborted) {
        throw new Error("Execution checkpoint cancelled");
      }
      const sessionId = ctx.sessionManager.getSessionId();
      if (!Value.Check(CheckpointSchema, params)) {
        throw new Error("Invalid execute_checkpoint input");
      }
      if (authorizations.get(params.invocationId) !== sessionId) {
        throw new Error(
          "Unauthorized checkpoint: explicitly invoke /execute in this session after stop or reload",
        );
      }
      if (ledger && ledger.sessionId !== sessionId) {
        throw new Error("Stale execution session");
      }
      if (ledger?.invocationId !== params.invocationId && calls.size > 0) {
        throw new Error(
          "Wait for active execution children to settle or abort the parent before consuming a new packet",
        );
      }
      if (
        (params.action === "block" || params.action === "repair") &&
        [...calls.values()].some(
          (binding) => binding.assignmentId === params.assignmentId,
        )
      ) {
        throw new Error(
          "Cannot release or repair an active child's write scope; await completion or abort the parent",
        );
      }
      const previousInvocationId = ledger?.invocationId;
      let current = ledger ?? emptyLedger(sessionId, params.invocationId);
      if (current.invocationId !== params.invocationId) {
        current = isLedgerComplete(current)
          ? emptyLedger(sessionId, params.invocationId)
          : {
              ...interruptLedger(
                current,
                "New explicit invocation; reconcile unfinished work before fresh children",
              ),
              invocationId: params.invocationId,
            };
      }
      const next = transitionLedger(current, params, randomUUID());
      persist(next);
      // A queued command authorizes only its own packet when consumed, not the active run.
      if (
        previousInvocationId &&
        previousInvocationId !== params.invocationId
      ) {
        authorizations.delete(previousInvocationId);
      }
      const assignment =
        params.action === "start"
          ? next.assignments.find((item) => item.id === params.assignmentId)
          : null;
      const output = {
        ledger: structuredClone(next),
        dispatchPrefix: assignment ? dispatchPrefix(next, assignment) : null,
      };
      if (params.action === "stop") {
        revoke("Execution stopped; explicit /execute required");
        ctx.abort();
      }
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
        details: {},
      };
    },
  });

  pi.on("tool_call", (event, ctx) => {
    if (
      event.toolName !== "subagent" ||
      typeof event.input.task !== "string" ||
      !event.input.task.startsWith("Execution binding:")
    ) {
      return;
    }
    try {
      if (loadError) {
        throw new Error(loadError);
      }
      if (
        !ledger ||
        ledger.sessionId !== ctx.sessionManager.getSessionId() ||
        authorizations.get(ledger.invocationId) !== ledger.sessionId
      ) {
        throw new Error("Unauthorized execution dispatch");
      }
      if (event.input.cwd !== undefined && event.input.cwd !== ctx.cwd) {
        throw new Error(
          "Execution dispatch must use the session's target workspace; omit cwd or use its exact path",
        );
      }
      const currentLedger = ledger;
      const task = event.input.task;
      const item = currentLedger.assignments.find((assignment) =>
        task.startsWith(dispatchPrefix(currentLedger, assignment)),
      );
      if (!item?.attemptId) {
        throw new Error("Unknown or stale execution dispatch prefix");
      }
      if (
        event.input.agent !== "executor" ||
        !isDeepStrictEqual(
          event.input.schema,
          JSON.parse(JSON.stringify(WorkerReportSchema)),
        )
      ) {
        throw new Error(
          "Execution requires executor and the exact worker report schema",
        );
      }
      persist(bindCall(ledger, item.id, item.attemptId, event.toolCallId));
      calls.set(event.toolCallId, {
        sessionId: ledger.sessionId,
        invocationId: ledger.invocationId,
        assignmentId: item.id,
        attemptId: item.attemptId,
      });
    } catch (error) {
      return { block: true, reason: errorMessage(error) };
    }
  });

  function consumeCall(
    toolCallId: string,
    ctx: ExtensionContext,
  ): BoundCall | undefined {
    const binding = calls.get(toolCallId);
    if (!binding) {
      return;
    }
    calls.delete(toolCallId);
    if (
      !ledger ||
      ledger.sessionId !== binding.sessionId ||
      ledger.sessionId !== ctx.sessionManager.getSessionId() ||
      ledger.invocationId !== binding.invocationId ||
      authorizations.get(binding.invocationId) !== binding.sessionId
    ) {
      ctx.ui.notify(
        "Stale execution result left unresolved; reconcile current ledger and workspace",
        "warning",
      );
      return;
    }
    return binding;
  }

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "subagent") {
      return;
    }
    // Later tool_call interceptors may block after we bind. Such calls skip
    // tool_result, but native direct AND nested execution always emit this end.
    // Consume only remaining bindings, never an already-recorded worker report.
    const binding = consumeCall(event.toolCallId, ctx);
    if (!binding || !ledger) {
      return;
    }
    const reason = event.isError
      ? "Subagent call failed or was blocked before its report; reconcile current workspace"
      : "Subagent call ended without an observed report; reconcile saved evidence and current workspace";
    persist(
      transitionLedger(ledger, {
        invocationId: ledger.invocationId,
        action: "block",
        assignmentId: binding.assignmentId,
        blockers: [reason],
      }),
    );
    ctx.ui.notify(reason, "warning");
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "subagent") {
      return;
    }
    const binding = consumeCall(event.toolCallId, ctx);
    if (!binding || !ledger) {
      return;
    }
    try {
      if (event.isError) {
        throw new Error(
          "Subagent call failed; inspect its saved evidence and current workspace",
        );
      }
      const envelope = readEnvelope(event.structuredContent);
      persist(
        recordReport(
          ledger,
          binding.assignmentId,
          binding.attemptId,
          event.toolCallId,
          envelope.runId,
          envelope.report,
        ),
      );
    } catch (error) {
      const reason = errorMessage(error);
      persist(
        transitionLedger(ledger, {
          invocationId: ledger.invocationId,
          action: "block",
          assignmentId: binding.assignmentId,
          blockers: [reason],
        }),
      );
      ctx.ui.notify(reason, "warning");
    }
  });

  return (ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (ledger && ledger.sessionId !== sessionId) {
      reload(ctx);
    }
    const invocationId = randomUUID();
    authorizations.set(invocationId, sessionId);
    return invocationId;
  };
}
