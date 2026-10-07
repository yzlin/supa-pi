import { randomUUID } from "node:crypto";

import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type {
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

import type { ReviewTarget } from "../shared/review-targets";
import { derivePreparedReviewResult } from "./finalization";
import { captureReviewTargetFreshness } from "./freshness";
import { runReviewPipeline } from "./pipeline";
import {
  prepareReviewPlan,
  type ReviewPipelineInput,
} from "./pipeline-contracts";
import { type ReviewWorkflowResult, renderReviewReport } from "./workflow";

interface PendingRun {
  id: string;
  sessionId: string;
  branchAnchor: string | null;
  cwd: string;
  target: ReviewTarget;
  fingerprint: string;
  plan: ReviewPipelineInput;
  controller: AbortController;
  invalid: boolean;
  started: boolean;
  finalizing: boolean;
  published: boolean;
  rawJson?: string;
  execution?: Promise<void>;
  detach: () => void;
}

/** Publication authority lives in local state, never tool arguments or child-derived fields. */
export class ReviewRunController {
  private pending?: PendingRun;
  private generation = 0;
  private preparing = false;

  get running(): boolean {
    return !!this.pending && !this.pending.invalid && !this.pending.published;
  }

  cancel(): string {
    this.generation += 1;
    const run = this.pending;
    if (run) {
      run.invalid = true;
      run.controller.abort();
      run.detach();
    }
    return "Review cancelled; owned queued/running children are being stopped and no report will be published.";
  }

  async settle(): Promise<void> {
    await this.pending?.execution?.catch(() => undefined);
  }

  async prepare(
    ctx: ExtensionContext,
    target: ReviewTarget,
    plan: ReviewPipelineInput,
    signal?: AbortSignal,
  ): Promise<Readonly<{ id: string }>> {
    if (this.running || this.preparing) {
      throw new Error("A review is already running.");
    }
    this.preparing = true;
    try {
      const generation = this.generation;
      const parentSignal = ctx.signal;
      const sessionId = ctx.sessionManager.getSessionId();
      const branchAnchor = ctx.sessionManager.getLeafId();
      const cwd = ctx.cwd;
      const savedTarget = structuredClone(target);
      const savedPlan = prepareReviewPlan(structuredClone(plan));
      const fingerprint = await captureReviewTargetFreshness(cwd, savedTarget, {
        signal,
      });
      if (
        signal?.aborted ||
        parentSignal?.aborted ||
        generation !== this.generation ||
        sessionId !== ctx.sessionManager.getSessionId() ||
        cwd !== ctx.cwd ||
        branchAnchor !== ctx.sessionManager.getLeafId()
      ) {
        throw new Error("Review preparation cancelled or session changed.");
      }
      const abort = () => {
        this.cancel();
      };
      const run: PendingRun = {
        id: randomUUID(),
        sessionId,
        branchAnchor,
        cwd,
        target: savedTarget,
        plan: savedPlan,
        fingerprint: fingerprint.digest,
        controller: new AbortController(),
        invalid: false,
        started: false,
        finalizing: false,
        published: false,
        detach: () => {
          signal?.removeEventListener("abort", abort);
          parentSignal?.removeEventListener("abort", abort);
        },
      };
      this.pending = run;
      signal?.addEventListener("abort", abort, { once: true });
      parentSignal?.addEventListener("abort", abort, { once: true });
      return Object.freeze({ id: run.id });
    } finally {
      this.preparing = false;
    }
  }

  private sameContext(run: PendingRun, ctx: ExtensionContext): boolean {
    return (
      !(
        run.invalid ||
        run.published ||
        ctx.signal?.aborted ||
        run.controller.signal.aborted
      ) &&
      ctx.cwd === run.cwd &&
      ctx.sessionManager.getSessionId() === run.sessionId &&
      (!run.branchAnchor ||
        ctx.sessionManager
          .getBranch()
          .some((entry) => entry.id === run.branchAnchor))
    );
  }

  private requireRun(runId: string, ctx: ExtensionContext): PendingRun {
    const run = this.pending;
    if (run?.id === runId && !this.sameContext(run, ctx)) {
      run.invalid = true;
      run.controller.abort();
      run.detach();
    }
    if (!run || run.id !== runId || !this.sameContext(run, ctx)) {
      throw new Error(
        "Unknown, invalid, replayed, or session/cwd/branch-changed review run.",
      );
    }
    return run;
  }

  private async assertFresh(
    run: PendingRun,
    ctx: ExtensionContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.sameContext(run, ctx) || signal.aborted) {
      throw new Error("Review cancelled or session/cwd/branch changed.");
    }
    const snapshot = await captureReviewTargetFreshness(run.cwd, run.target, {
      signal,
    });
    if (
      !this.sameContext(run, ctx) ||
      signal.aborted ||
      snapshot.digest !== run.fingerprint
    ) {
      throw new Error(
        "Review target is stale or review cancelled; run /review again.",
      );
    }
  }

  async run(
    runId: string,
    ctx: ExtensionToolContext,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<void> {
    const run = this.requireRun(runId, ctx);
    if (run.started) {
      throw new Error(
        "Review run already dispatched; no replay or concurrent execution.",
      );
    }
    run.started = true;
    const parentSignal = ctx.signal;
    const abort = () => {
      run.invalid = true;
      run.controller.abort();
    };
    const detach = run.detach;
    run.detach = () => {
      detach();
      signal?.removeEventListener("abort", abort);
      parentSignal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
    parentSignal?.addEventListener("abort", abort, { once: true });
    const combined = AbortSignal.any([
      run.controller.signal,
      ...[signal, parentSignal].filter(
        (value): value is AbortSignal => !!value,
      ),
    ]);
    const execute = async () => {
      try {
        await this.assertFresh(run, ctx, combined);
        const raw = await runReviewPipeline(ctx, run.plan, {
          signal: combined,
          onUpdate,
        });
        await this.assertFresh(run, ctx, combined);
        run.rawJson = JSON.stringify(raw);
      } catch (error) {
        run.invalid = true;
        run.controller.abort();
        run.detach();
        throw error;
      }
    };
    run.execution = execute();
    await run.execution;
  }

  async finalize(
    runId: string,
    ctx: ExtensionContext,
    publish: (result: ReviewWorkflowResult) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const run = this.requireRun(runId, ctx);
    if (run.finalizing || !run.rawJson) {
      throw new Error("Review not ready or concurrently finalizing.");
    }
    run.finalizing = true;
    const combined = AbortSignal.any([
      run.controller.signal,
      ...[signal, ctx.signal].filter((value): value is AbortSignal => !!value),
    ]);
    try {
      await this.assertFresh(run, ctx, combined);
      const result = derivePreparedReviewResult(run.plan, run.rawJson);
      await this.assertFresh(run, ctx, combined);
      const report = renderReviewReport(result.verifier, result.coverage);
      run.published = true;
      run.detach();
      publish({ ...result, report });
    } catch (error) {
      run.invalid = true;
      run.controller.abort();
      run.detach();
      throw new Error(
        `Review finalization failed: ${error instanceof Error ? error.message : "Invalid capture."}`,
      );
    } finally {
      run.finalizing = false;
    }
  }
}
