import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createTwoFilesPatch } from "diff";
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
import { askReview } from "./review-dialog";
import {
  type Checkpoint,
  CheckpointOutputSchema,
  CheckpointParametersSchema,
  CheckpointSchema,
  type ExecutionLedger,
  type SpecResume,
  type SpecReviewReport,
  SpecReviewReportSchema,
  WorkerReportSchema,
} from "./schema";
import { draftedSpecSlug } from "./spec-draft";
import {
  appendSpecEvents,
  deleteSnapshotRefs,
  deriveSpecResume,
  hashSpec,
  parseDoneCriteria,
  parseSpecPath,
  readSpecLog,
  reviewState,
  snapshotWorkspace,
  type SpecLogEvent,
  specEventsFromTransition,
} from "./spec-log";
import {
  decideSpecReview,
  type SpecReviewDecision,
  type SpecReviewTrigger,
} from "./spec-review";

interface BoundCall {
  sessionId: string;
  invocationId: string;
  assignmentId: string;
  attemptId: string;
}

const REVIEW_PREFIX = "Spec review binding:";
const REVIEW_FOCUS_LABEL = "Focus: ";
// Each focus may be dispatched once more after a failed or invalid report.
const REVIEW_ATTEMPTS = 2;
const REVIEW_SPEC_SHOWN = "spec-review";
const UNAUTHORIZED =
  "Unauthorized checkpoint: explicitly invoke /execute in this session after stop or reload";

interface ReviewSlot {
  status: "pending" | "bound" | "done" | "failed";
  attempts: number;
  report?: SpecReviewReport;
}
// One in-memory Spec review round for an invocation and Spec hash.
interface ReviewRound {
  sessionId: string;
  invocationId: string;
  specPath: string;
  hash: string;
  round: number;
  trigger: SpecReviewTrigger;
  // Loop limit reached: no reviewers, only the accept-as-is or stop gate.
  limit: boolean;
  prefix: string;
  focus: string[];
  slots: ReviewSlot[];
  resolving: boolean;
}
type ReviewCheckpoint = Extract<
  Checkpoint,
  { action: "review" | "resolve_review" }
>;

function revisionText(
  events: SpecLogEvent[],
  round: Pick<ReviewRound, "specPath" | "hash" | "round">,
  content: string,
): string | undefined {
  const previous = events.findLast(
    (event) => event.event === "reviewed" && event.hash !== round.hash,
  );
  if (previous?.event !== "reviewed") {
    return undefined;
  }
  if (previous.content === undefined) {
    return `Spec ${round.specPath} changed since review round ${previous.round}; no reviewed copy is stored, so no diff is shown. Read the Spec before choosing.`;
  }
  const patch = createTwoFilesPatch(
    `${round.specPath} (round ${previous.round})`,
    `${round.specPath} (round ${round.round})`,
    previous.content,
    content,
    undefined,
    undefined,
    { context: 3 },
  );
  // Context lines indent Spec fences by one space, which still closes a
  // three-backtick fence, so the outer fence outruns every backtick run.
  const longest = Math.max(
    0,
    ...(patch.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `Spec revision since review round ${previous.round}:\n${fence}diff\n${patch}${fence}`;
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
  // Spec review trigger results per invocation and Spec hash.
  const reviewDecisions = new Map<string, SpecReviewDecision>();
  const reviewKey = (invocationId: string, specHash: string) =>
    JSON.stringify([invocationId, specHash]);
  // Live review rounds by reviewKey, and bound reviewer calls by tool call.
  const reviewRounds = new Map<string, ReviewRound>();
  const reviewCalls = new Map<string, { round: ReviewRound; slot: number }>();
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

  function clearReviews(): void {
    reviewRounds.clear();
    reviewCalls.clear();
  }

  function liveRound(round: ReviewRound, sessionId: string): boolean {
    return (
      reviewRounds.get(reviewKey(round.invocationId, round.hash)) === round &&
      round.sessionId === sessionId &&
      authorizations.get(round.invocationId) === sessionId
    );
  }

  function readSpec(path: string, cwd: string) {
    const { specPath, logPath } = parseSpecPath(path);
    const absSpecPath = resolve(cwd, specPath);
    if (!existsSync(absSpecPath)) {
      throw new Error(`Spec not found: ${specPath}`);
    }
    const content = readFileSync(absSpecPath, "utf8");
    return {
      specPath,
      content,
      hash: hashSpec(content),
      absLogPath: resolve(cwd, logPath),
    };
  }

  // Returns the cached or freshly classified review trigger for this hash.
  // `classified` tells callers to re-check state that may have changed.
  async function reviewTrigger(
    invocationId: string,
    sessionId: string,
    content: string,
    hash: string,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<{ decision: SpecReviewDecision; classified: boolean }> {
    const key = reviewKey(invocationId, hash);
    const cached = reviewDecisions.get(key);
    if (cached) {
      return { decision: cached, classified: false };
    }
    const decision = await decideSpecReview({
      content,
      registry: ctx.modelRegistry,
      notify: (message) => ctx.ui.notify(message, "warning"),
      signal,
    });
    if (signal?.aborted) {
      throw new Error("Execution checkpoint cancelled");
    }
    reviewDecisions.set(key, decision);
    // Authorization may change while classifying.
    if (authorizations.get(invocationId) !== sessionId) {
      throw new Error(UNAUTHORIZED);
    }
    return { decision, classified: true };
  }

  async function reviewCheckpoint(
    params: ReviewCheckpoint,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    sessionId: string,
  ) {
    if (!ctx.hasUI) {
      throw new Error("Spec review needs an interactive session");
    }
    const spec = readSpec(params.specPath, ctx.cwd);
    const key = reviewKey(params.invocationId, spec.hash);
    const output = (
      dispatch: string | null,
      review: Record<string, unknown>,
    ) => {
      const result = {
        ledger: structuredClone(
          ledger ?? emptyLedger(sessionId, params.invocationId),
        ),
        dispatchPrefix: dispatch,
        review,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
        details: {},
      };
    };
    if (params.action === "review") {
      const events = readSpecLog(spec.absLogPath);
      if (
        events.some(
          (event) => event.event === "accepted" && event.hash === spec.hash,
        )
      ) {
        throw new Error(
          "Spec already accepted for its current hash; review applies only before accept",
        );
      }
      if (
        events.some(
          (event) => event.event === "reviewed" && event.hash === spec.hash,
        )
      ) {
        throw new Error(
          "Spec already reviewed for its current hash; revise the Spec or accept it",
        );
      }
      if (reviewRounds.has(key)) {
        throw new Error(
          "Spec review round already started for this Spec hash; dispatch its reviewers or call resolve_review",
        );
      }
      const { decision, classified } = await reviewTrigger(
        params.invocationId,
        sessionId,
        spec.content,
        spec.hash,
        ctx,
        signal,
      );
      if (classified && reviewRounds.has(key)) {
        throw new Error("Spec review round already started");
      }
      if (!decision.required) {
        throw new Error(
          "Spec review is not required for this Spec hash; accept it directly",
        );
      }
      const { reviewedHashes } = reviewState(events, spec.hash);
      const limit = reviewedHashes >= 2;
      const { slug } = parseSpecPath(spec.specPath);
      const round: ReviewRound = {
        sessionId,
        invocationId: params.invocationId,
        specPath: spec.specPath,
        hash: spec.hash,
        round: reviewedHashes + 1,
        trigger: decision.trigger,
        limit,
        prefix: `${REVIEW_PREFIX} ${params.invocationId}/${slug}/${randomUUID()}\n`,
        focus: [...params.focus],
        slots: params.focus.map(() => ({ status: "pending", attempts: 0 })),
        resolving: false,
      };
      reviewRounds.set(key, round);
      return output(limit ? null : round.prefix, {
        round: round.round,
        limit,
        note: limit
          ? "Spec review round limit reached (two reviewed hashes); no reviewers run. Call resolve_review so the user can accept as is or stop."
          : `Dispatch exactly two subagent calls: agent spec-reviewer, the exact SpecReviewReportSchema, no cwd, the task starting with dispatchPrefix and one "${REVIEW_FOCUS_LABEL}<statement>" line per focus. Then call resolve_review.`,
      });
    }
    const round = reviewRounds.get(key);
    if (!round) {
      throw new Error(
        "No live Spec review round for the current Spec hash; call review first",
      );
    }
    if (round.resolving) {
      throw new Error("Spec review resolution already in progress");
    }
    const missing = round.focus.filter(
      (_focus, index) => round.slots[index]?.status !== "done",
    );
    if (!round.limit && missing.length) {
      throw new Error(
        `Spec review reports missing for focus: ${missing.join("; ")}`,
      );
    }
    const reports = round.limit
      ? []
      : round.slots.flatMap((slot, index) =>
          slot.report ? [{ slot: index, report: slot.report }] : [],
        );
    const findings = reports.flatMap(({ report }) => report.findings);
    const questions = reports.flatMap(({ slot, report }) =>
      report.questions.map((question) => ({ slot, question })),
    );
    const answers: Array<{
      id: string;
      focus: string;
      question: string;
      answer: string;
    }> = [];
    let choice: string | undefined;
    round.resolving = true;
    try {
      const revision = revisionText(
        readSpecLog(spec.absLogPath),
        round,
        spec.content,
      );
      const sections = [revision];
      if (!round.limit) {
        const summary = findings.map(
          (finding) =>
            `- [${finding.severity}] ${finding.target}: ${finding.why} → ${finding.change}`,
        );
        sections.push(
          `Spec review of ${round.specPath} (round ${round.round}): ${findings.length} findings\n${summary.join("\n")}`,
        );
      }
      const shown = sections.filter(Boolean).join("\n\n");
      // Transcript record. Pi appends it only after this tool call ends, so
      // the prompts below carry the same text as their preview.
      if (shown) {
        pi.sendMessage(
          { customType: REVIEW_SPEC_SHOWN, content: shown, display: true },
          { triggerTurn: false },
        );
      }
      for (const { slot, question } of questions) {
        const answer = await askReview(
          ctx,
          shown,
          { title: question.question, options: question.options, custom: true },
          signal,
        );
        if (answer === undefined) {
          throw new Error("Spec review cancelled; nothing recorded");
        }
        const focus = round.focus[slot];
        if (focus === undefined) {
          throw new Error(`Spec review focus missing for slot ${slot}`);
        }
        answers.push({
          id: `${slot}:${question.id}`,
          focus,
          question: question.question,
          answer,
        });
      }
      choice = await askReview(
        ctx,
        shown,
        {
          title: round.limit
            ? `Spec review round limit reached for ${round.specPath}. Accept as is or stop?`
            : `Spec review of ${round.specPath}: ${findings.length} findings. Accept as reviewed or revise?`,
          options: round.limit
            ? ["Accept as is", "Stop"]
            : ["Accept as reviewed", "Revise"],
        },
        signal,
      );
      if (choice === undefined) {
        throw new Error("Spec review cancelled; nothing recorded");
      }
    } finally {
      round.resolving = false;
    }
    // Authorization or the Spec may change while the prompts are open.
    if (!liveRound(round, ctx.sessionManager.getSessionId())) {
      throw new Error(UNAUTHORIZED);
    }
    if (readSpec(round.specPath, ctx.cwd).hash !== round.hash) {
      throw new Error("Spec changed during review; nothing recorded");
    }
    let decision: "accept" | "revise" | "stop" = "accept";
    if (choice === "Revise") {
      decision = "revise";
    } else if (choice === "Stop") {
      decision = "stop";
    }
    appendSpecEvents(spec.absLogPath, [
      {
        event: "reviewed",
        ts: new Date().toISOString(),
        hash: round.hash,
        round: round.round,
        trigger: round.trigger,
        decision,
        answers,
        findings: findings.length,
        content: spec.content,
      },
    ]);
    reviewRounds.delete(key);
    const notes = {
      accept: "User accepted the Spec; call accept now.",
      revise:
        "User chose to revise; show the revised Spec or diff in a message, keep any ask prompt to one short line, then accept again.",
      stop: "User stopped; do not accept this Spec.",
    };
    return output(null, {
      round: round.round,
      limit: round.limit,
      note: notes[decision],
      decision,
      answers,
      findings,
    });
  }

  function revoke(reason: string, ctx?: ExtensionContext): void {
    authorizations.clear();
    approvedCwds.clear();
    calls.clear();
    clearReviews();
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
    clearReviews();
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
        throw new Error(UNAUTHORIZED);
      }
      if (ledger && ledger.sessionId !== sessionId) {
        throw new Error("Stale execution session");
      }
      if (params.action === "review" || params.action === "resolve_review") {
        return reviewCheckpoint(params, ctx, signal ?? undefined, sessionId);
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
      let specCriteria: string[] | undefined;
      let reviewGate:
        | {
            specPath: string;
            content: string;
            hash: string;
            events: SpecLogEvent[];
          }
        | undefined;
      const extraEvents: SpecLogEvent[] = [];
      const ts = new Date().toISOString();
      if (params.action === "accept") {
        if (params.reviseSpec !== undefined && !params.specPath) {
          throw new Error("reviseSpec requires specPath");
        }
        if (params.specPath) {
          const {
            specPath,
            content,
            hash: currentHash,
            absLogPath,
          } = readSpec(params.specPath, ctx.cwd);
          specCriteria = parseDoneCriteria(content);
          const events = readSpecLog(absLogPath);
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
            criteria: [...specCriteria],
            assignments: params.assignments.map(
              ({ id, dependencies, criteria }) => ({
                id,
                dependencies: [...dependencies],
                ...(criteria ? { criteria: [...criteria] } : {}),
              }),
            ),
          });
          resume = derived ?? undefined;
          // Re-accepting an already-accepted hash skips the review trigger.
          if (
            !events.some(
              (event) =>
                event.event === "accepted" && event.hash === currentHash,
            )
          ) {
            reviewGate = { specPath, content, hash: currentHash, events };
          }
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
      const next = transitionLedger(
        current,
        input,
        randomUUID(),
        resume,
        specCriteria,
      );
      if (reviewGate) {
        const { approved, latestDecision } = reviewState(
          reviewGate.events,
          reviewGate.hash,
        );
        // A recorded stop/revise is durable; it outranks a fresh trigger.
        if (latestDecision === "stop" || latestDecision === "revise") {
          throw new Error(
            `Spec review recorded "${latestDecision}" for this Spec hash; revise the Spec (a new hash) before accept`,
          );
        }
        const { decision, classified } = await reviewTrigger(
          params.invocationId,
          sessionId,
          reviewGate.content,
          reviewGate.hash,
          ctx,
          signal ?? undefined,
        );
        // The ledger may change while classifying.
        if (classified && ledger !== previousLedger) {
          throw new Error(
            "Execution ledger changed during Spec review trigger; accept again",
          );
        }
        if (decision.required && !approved) {
          throw new Error(
            ctx.hasUI
              ? `Spec review required before accept: call execute_checkpoint review for ${reviewGate.specPath}`
              : "Spec review required; it needs an interactive session",
          );
        }
      }
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
          throw new Error(UNAUTHORIZED);
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

  function bindReviewer(
    toolCallId: string,
    input: Record<string, unknown>,
    task: string,
    sessionId: string,
  ): void {
    if (loadError) {
      throw new Error(loadError);
    }
    const round = [...reviewRounds.values()].find(
      (candidate) => !candidate.limit && task.startsWith(candidate.prefix),
    );
    if (!round || !liveRound(round, sessionId) || round.resolving) {
      throw new Error("Unknown or stale Spec review prefix");
    }
    if (input.agent !== "spec-reviewer") {
      throw new Error("Spec review requires agent spec-reviewer");
    }
    if (
      !isDeepStrictEqual(
        input.schema,
        JSON.parse(JSON.stringify(SpecReviewReportSchema)),
      )
    ) {
      throw new Error("Spec review requires the exact SpecReviewReportSchema");
    }
    if (input.cwd !== undefined) {
      throw new Error("Spec review runs in the session workspace; omit cwd");
    }
    const declared = task
      .slice(round.prefix.length)
      .split(/\r?\n/u)
      .filter((line) => line.startsWith(REVIEW_FOCUS_LABEL))
      .map((line) => line.slice(REVIEW_FOCUS_LABEL.length).trim());
    if (declared.length !== 1) {
      throw new Error(
        `Spec review task must contain exactly one "${REVIEW_FOCUS_LABEL}<statement>" line`,
      );
    }
    const index = round.focus.indexOf(declared[0] ?? "");
    const slot = round.slots[index];
    if (!slot) {
      throw new Error("Unknown Spec review focus; use a declared statement");
    }
    if (round.slots.filter((item) => item.status === "bound").length >= 2) {
      throw new Error("Spec review allows only two reviewer calls at a time");
    }
    if (slot.status === "bound" || slot.status === "done") {
      throw new Error("Spec review focus already bound or reported");
    }
    if (slot.attempts >= REVIEW_ATTEMPTS) {
      throw new Error(
        "Spec review focus failed twice; no retry left. Revise the Spec or ask the user",
      );
    }
    slot.status = "bound";
    slot.attempts++;
    reviewCalls.set(toolCallId, { round, slot: index });
  }

  // Records a reviewer's run-bound report, or marks its focus failed.
  function settleReviewer(
    toolCallId: string,
    ctx: ExtensionContext,
    result?: { isError: boolean; structuredContent?: unknown },
  ): void {
    const binding = reviewCalls.get(toolCallId);
    if (!binding) {
      return;
    }
    reviewCalls.delete(toolCallId);
    const slot = binding.round.slots[binding.slot];
    if (
      !slot ||
      slot.status !== "bound" ||
      !liveRound(binding.round, ctx.sessionManager.getSessionId())
    ) {
      ctx.ui.notify("Stale Spec review result ignored", "warning");
      return;
    }
    try {
      if (!result) {
        throw new Error("Spec reviewer ended without an observed report");
      }
      if (result.isError) {
        throw new Error("Spec reviewer call failed");
      }
      const { report } = readEnvelope(result.structuredContent);
      if (!Value.Check(SpecReviewReportSchema, report)) {
        throw new Error("Spec reviewer report does not match its schema");
      }
      slot.status = "done";
      slot.report = structuredClone(report);
    } catch (error) {
      slot.status = "failed";
      ctx.ui.notify(
        `${errorMessage(error)}; focus "${binding.round.focus[binding.slot]}" ${slot.attempts < REVIEW_ATTEMPTS ? "may be dispatched once more" : "has no retry left"}`,
        "warning",
      );
    }
  }

  pi.on("tool_call", async (event, ctx) => {
    if (
      event.toolName === "subagent" &&
      typeof event.input.task === "string" &&
      event.input.task.startsWith(REVIEW_PREFIX)
    ) {
      try {
        bindReviewer(
          event.toolCallId,
          event.input,
          event.input.task,
          ctx.sessionManager.getSessionId(),
        );
      } catch (error) {
        return { block: true, reason: errorMessage(error) };
      }
      return;
    }
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
    settleReviewer(event.toolCallId, ctx);
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
    settleReviewer(event.toolCallId, ctx, event);
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
