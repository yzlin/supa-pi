import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { SPEC_DRAFTED_ENTRY_TYPE } from "./constants";
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
  type CheckpointArgs,
  renderCheckpointCall,
  renderCheckpointResult,
} from "./render";
import {
  CheckpointOutputSchema,
  CheckpointParametersSchema,
  CheckpointSchema,
  type ExecutionLedger,
  type SpecResume,
  WorkerReportSchema,
} from "./schema";
import { draftedSpecSlug } from "./spec-draft";
import {
  appendSpecEvents,
  deleteSnapshotRefs,
  deriveSpecResume,
  hashSpec,
  parseSpecPath,
  readSpecLog,
  snapshotWorkspace,
  type SpecLogEvent,
  specEventsFromTransition,
} from "./spec-log";

interface BoundCall {
  sessionId: string;
  invocationId: string;
  assignmentId: string;
  attemptId: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Execution checkpoint failed";
}

function isOutside(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

// Mirrors subagent cwd resolution. Returns undefined for the workspace itself,
// a workspace-relative path inside it, or an absolute real path outside it.
function resolveCwd(workspace: string, cwd: string): string | undefined {
  let root: string;
  let target: string;
  try {
    root = realpathSync(workspace);
    target = realpathSync(resolve(workspace, cwd));
  } catch {
    throw new Error(`Execution cwd does not exist: ${cwd}`);
  }
  if (!statSync(target).isDirectory()) {
    throw new Error(`Execution cwd is not a directory: ${cwd}`);
  }
  const path = relative(root, target);
  if (!path) {
    return undefined;
  }
  // Absolute and workspace-relative scopes are never compared, so an outside
  // cwd that contains the workspace would hide overlaps.
  if (!isOutside(relative(target, root))) {
    throw new Error(`Execution cwd must not contain the workspace: ${cwd}`);
  }
  return isOutside(path) ? target : path;
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
  // Outside-workspace cwds the user approved, per invocation.
  const approvedCwds = new Map<string, Set<string>>();
  const pendingApprovals = new Map<string, Promise<boolean>>();
  const calls = new Map<string, BoundCall>();
  let stopWatchingAbort: (() => void) | undefined;
  let workspace: string | undefined;

  function clearAbortWatcher(): void {
    stopWatchingAbort?.();
    stopWatchingAbort = undefined;
  }

  function persist(
    next: ExecutionLedger,
    ctx?: ExtensionContext,
    strict = false,
    extraEvents: SpecLogEvent[] = [],
  ): void {
    workspace = ctx?.cwd ?? workspace;
    try {
      if (next.specPath) {
        if (!workspace) {
          throw new Error("Spec logging requires a workspace");
        }
        const { slug, logPath } = parseSpecPath(next.specPath);
        const absLogPath = resolve(workspace, logPath);
        const logged = readSpecLog(absLogPath);
        let verifiedCount = logged.filter(
          (event) => event.event === "verified",
        ).length;
        const events = [
          ...extraEvents.filter((event) => event.event !== "stopped"),
          ...specEventsFromTransition(ledger, next, new Date().toISOString()),
          ...extraEvents.filter((event) => event.event === "stopped"),
        ];
        for (const event of events) {
          if (event.event === "verified") {
            Object.assign(
              event,
              snapshotWorkspace(workspace, slug, ++verifiedCount),
            );
          }
        }
        appendSpecEvents(absLogPath, events);
        if (events.some((event) => event.event === "done")) {
          // Cleanup follows the durable done event; failing here would make a
          // retry duplicate logged events.
          try {
            deleteSnapshotRefs(workspace, slug);
          } catch (error) {
            ctx?.ui.notify(
              `Spec snapshot cleanup failed: ${errorMessage(error)}`,
              "warning",
            );
          }
        }
      }
    } catch (error) {
      if (strict) {
        throw error;
      }
      ctx?.ui.notify(`Spec log failed: ${errorMessage(error)}`, "error");
    }
    pi.appendEntry(LEDGER_ENTRY_TYPE, structuredClone(next));
    ledger = next;
  }

  function approveCwds(invocationId: string, cwds: string[]): void {
    const approved = approvedCwds.get(invocationId) ?? new Set<string>();
    for (const cwd of cwds) {
      approved.add(cwd);
    }
    approvedCwds.set(invocationId, approved);
  }

  // Fallback for an invocation that did not approve the cwd at accept, such as
  // one continuing an unfinished ledger: ask once per cwd. Concurrent
  // dispatches share one prompt, since Pi orphans a displaced dialog.
  async function confirmOutsideCwd(
    invocationId: string,
    cwd: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (approvedCwds.get(invocationId)?.has(cwd)) {
      return;
    }
    if (!ctx.hasUI) {
      throw new Error(
        "Execution dispatch outside the session workspace requires interactive approval",
      );
    }
    const key = JSON.stringify([invocationId, cwd]);
    let pending = pendingApprovals.get(key);
    if (!pending) {
      pending = ctx.ui
        .confirm(
          "Run execution workers outside the workspace?",
          `Execution workers would run in:\n${cwd}\n\nSession workspace:\n${ctx.cwd}`,
          { signal: ctx.signal },
        )
        .finally(() => {
          pendingApprovals.delete(key);
        });
      pendingApprovals.set(key, pending);
    }
    if (!(await pending)) {
      throw new Error(
        "User declined execution dispatch outside the session workspace",
      );
    }
    if (
      authorizations.get(invocationId) === ctx.sessionManager.getSessionId()
    ) {
      approveCwds(invocationId, [cwd]);
    }
  }

  function revoke(reason: string, ctx?: ExtensionContext): void {
    authorizations.clear();
    approvedCwds.clear();
    calls.clear();
    if (ledger) {
      persist(interruptLedger(ledger, reason), ctx);
    }
  }

  function reload(ctx: ExtensionContext): void {
    workspace = ctx.cwd;
    clearAbortWatcher();
    authorizations.clear();
    approvedCwds.clear();
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
    workspace = ctx.cwd;
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
        ctx,
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
  pi.on("agent_before_settle", (event, ctx) => {
    if (event.outcome === "aborted" || event.outcome === "error") {
      revoke(
        "Parent interrupted; explicit /execute and current-state reconciliation required",
        ctx,
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
    renderShell: "self",
    renderCall: (args, theme, context) =>
      renderCheckpointCall(args as CheckpointArgs, theme, context),
    renderResult: (result, options, theme, context) =>
      renderCheckpointResult(result, options, theme, {
        ...context,
        args: context.args as CheckpointArgs,
      }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      workspace = ctx.cwd;
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
      const previousLedger = ledger;
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
      let resume: SpecResume | undefined;
      const extraEvents: SpecLogEvent[] = [];
      const ts = new Date().toISOString();
      if (params.action === "accept") {
        if (params.reviseSpec !== undefined && !params.specPath) {
          throw new Error("reviseSpec requires specPath");
        }
        if (params.specPath) {
          const { specPath, logPath } = parseSpecPath(params.specPath);
          const absSpecPath = resolve(ctx.cwd, specPath);
          if (!existsSync(absSpecPath)) {
            throw new Error(`Spec not found: ${specPath}`);
          }
          const currentHash = hashSpec(readFileSync(absSpecPath, "utf8"));
          const events = readSpecLog(resolve(ctx.cwd, logPath));
          const { hash: loggedHash, resume: derived } =
            deriveSpecResume(events);
          const changed = loggedHash !== null && loggedHash !== currentHash;
          if (changed && params.reviseSpec !== true) {
            throw new Error(
              "Spec changed since it was accepted; ask the user to revise (accept again with reviseSpec: true) or restore the Spec",
            );
          }
          if (params.reviseSpec === true && !changed) {
            throw new Error("reviseSpec is only valid when the Spec changed");
          }
          if (changed && loggedHash) {
            extraEvents.push({
              event: "revised",
              ts,
              hash: currentHash,
              previousHash: loggedHash,
            });
          }
          extraEvents.push({
            event: "accepted",
            ts,
            hash: currentHash,
            invocationId: params.invocationId,
            assignments: params.assignments.map(({ id, dependencies }) => ({
              id,
              dependencies: [...dependencies],
            })),
          });
          resume = events.length ? (derived ?? undefined) : undefined;
        }
      }
      const input =
        params.action === "accept"
          ? {
              ...params,
              assignments: params.assignments.map(({ cwd, ...assignment }) => {
                const resolved =
                  cwd === undefined ? undefined : resolveCwd(ctx.cwd, cwd);
                return resolved === undefined
                  ? assignment
                  : { ...assignment, cwd: resolved };
              }),
            }
          : params;
      const next = transitionLedger(current, input, randomUUID(), resume);
      const outsideCwds =
        params.action === "accept"
          ? [
              ...new Set(
                next.assignments.flatMap(({ cwd }) =>
                  cwd && isAbsolute(cwd) ? [cwd] : [],
                ),
              ),
            ]
          : [];
      if (outsideCwds.length > 0) {
        if (!ctx.hasUI) {
          throw new Error(
            "Accepting assignments outside the session workspace requires interactive approval",
          );
        }
        const approved = await ctx.ui.confirm(
          "Run execution workers outside the workspace?",
          `Accepted assignments would run in:\n${outsideCwds.join("\n")}\n\nSession workspace:\n${ctx.cwd}`,
          { signal: ctx.signal },
        );
        if (!approved) {
          throw new Error(
            "Execution plan not approved: user declined or cancelled running assignments outside the session workspace",
          );
        }
        // Authorization or the ledger may change while the prompt is open.
        if (authorizations.get(params.invocationId) !== sessionId) {
          throw new Error(
            "Unauthorized checkpoint: explicitly invoke /execute in this session after stop or reload",
          );
        }
        if (ledger !== previousLedger) {
          throw new Error(
            "Execution ledger changed during approval; accept again",
          );
        }
      }
      if (params.action === "stop" && next.specPath) {
        extraEvents.push({
          event: "stopped",
          ts,
          reason:
            "Execution stopped; explicit /execute and current-state reconciliation required",
        });
      }
      // Log failures must not block reading the ledger or stopping the run;
      // non-strict persist still notifies the named log error.
      persist(
        next,
        ctx,
        params.action !== "stop" && params.action !== "inspect",
        extraEvents,
      );
      if (outsideCwds.length > 0) {
        approveCwds(params.invocationId, outsideCwds);
      }
      // A queued command authorizes only its own packet when consumed, not the active run.
      if (
        previousInvocationId &&
        previousInvocationId !== params.invocationId
      ) {
        authorizations.delete(previousInvocationId);
        approvedCwds.delete(previousInvocationId);
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
        revoke("Execution stopped; explicit /execute required", ctx);
        ctx.abort();
      }
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
        details: {},
      };
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (
      event.toolName !== "subagent" ||
      typeof event.input.task !== "string" ||
      !event.input.task.startsWith("Execution binding:")
    ) {
      return;
    }
    const task = event.input.task;
    const validate = () => {
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
      const currentLedger = ledger;
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
      return { current: currentLedger, item };
    };
    try {
      const { current: requestedLedger, item: requestedItem } = validate();
      const requested: unknown = event.input.cwd;
      if (requested !== undefined && typeof requested !== "string") {
        throw new Error("Execution dispatch cwd must be a string");
      }
      const actual =
        typeof requested === "string"
          ? resolveCwd(ctx.cwd, requested)
          : undefined;
      if (actual !== requestedItem.cwd) {
        throw new Error(
          `Execution dispatch cwd must match assignment ${requestedItem.id}'s accepted cwd (${requestedItem.cwd ?? "session workspace"})`,
        );
      }
      if (requestedItem.cwd && isAbsolute(requestedItem.cwd)) {
        await confirmOutsideCwd(
          requestedLedger.invocationId,
          requestedItem.cwd,
          ctx,
        );
      }
      // The ledger may change while the prompt is open; validate again.
      const { current, item } = validate();
      persist(
        bindCall(current, item.id, item.attemptId, event.toolCallId),
        ctx,
      );
      calls.set(event.toolCallId, {
        sessionId: current.sessionId,
        invocationId: current.invocationId,
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
      ctx,
    );
    ctx.ui.notify(reason, "warning");
  });

  pi.on("tool_result", (event, ctx) => {
    if (
      (event.toolName === "write" || event.toolName === "edit") &&
      !event.isError
    ) {
      const slug = draftedSpecSlug(ctx.cwd, event.input.path);
      if (slug) {
        pi.appendEntry(SPEC_DRAFTED_ENTRY_TYPE, { slug });
      }
    }
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
        ctx,
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
        ctx,
      );
      ctx.ui.notify(reason, "warning");
    }
  });

  return (ctx) => {
    workspace = ctx.cwd;
    const sessionId = ctx.sessionManager.getSessionId();
    if (ledger && ledger.sessionId !== sessionId) {
      reload(ctx);
    }
    const invocationId = randomUUID();
    authorizations.set(invocationId, sessionId);
    return invocationId;
  };
}
