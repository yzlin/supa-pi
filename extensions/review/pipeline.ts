import path from "node:path";

import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { derivePreparedReviewResult } from "./finalization";
import {
  prepareReviewPlan,
  type ReviewPipelineInput,
  type ReviewRawResult,
} from "./pipeline-contracts";
import {
  buildReviewerPrompt,
  buildSynthesizerPrompt,
  buildVerifierPrompt,
  reviewerSchema,
  synthesizerSchema,
  verifierSchema,
} from "./pipeline-prompts";
import {
  buildPortableCandidateFindings,
  parsePortableSynthesizerOutput,
  validatePortableReviewer,
  validatePortableVerifier,
} from "./portable-core";
import { REVIEW_WORKFLOW_CONCURRENCY } from "./workflow";
import type {
  ReviewCandidateFindingContract,
  ReviewerJsonContract,
  ReviewRunOutcome,
  SynthesizedClusterContract,
} from "./workflow";

const CHILD_RUN_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RESULT_KEYS = [
  "runId",
  "agent",
  "provider",
  "model",
  "thinking",
  "output",
  "structuredOutput",
  "resultPath",
  "sessionFile",
];

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Review cancelled.");
  }
}

/** Calls the public tool path so profile refresh and the shared scheduler remain authoritative. */
export async function runReviewPipeline(
  ctx: Pick<ExtensionToolContext, "executeTool">,
  input: ReviewPipelineInput,
  options: { signal: AbortSignal; onUpdate?: AgentToolUpdateCallback },
): Promise<Readonly<ReviewRawResult>> {
  const plan = prepareReviewPlan(input);
  const { onUpdate } = options;
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const ids = new Set<string>();
  const invoke = async (
    agent: string,
    model: string,
    thinking: string,
    task: string,
    schema: Record<string, unknown>,
  ) => {
    checkAbort(signal);
    const outcome = await ctx.executeTool(
      "subagent",
      { agent, model, thinking, task, schema },
      { signal, onUpdate },
    );
    checkAbort(signal);
    if (outcome.isError) {
      return { failed: true as const };
    }
    const result = outcome.result.structuredContent;
    const separator = model.indexOf("/");
    if (
      !record(result) ||
      Object.keys(result).some((key) => !RESULT_KEYS.includes(key)) ||
      typeof result.runId !== "string" ||
      !CHILD_RUN_ID.test(result.runId) ||
      ids.has(result.runId) ||
      result.agent !== agent ||
      result.provider !== model.slice(0, separator) ||
      result.model !== model.slice(separator + 1) ||
      result.thinking !== thinking ||
      typeof result.output !== "string" ||
      typeof result.resultPath !== "string" ||
      !path.isAbsolute(result.resultPath) ||
      (result.sessionFile !== undefined &&
        (typeof result.sessionFile !== "string" ||
          !path.isAbsolute(result.sessionFile))) ||
      !record(result.structuredOutput)
    ) {
      throw new Error("Invalid or mismatched subagent review capture.");
    }
    ids.add(result.runId);
    const serialized = JSON.stringify(result.structuredOutput);
    if (Buffer.byteLength(serialized) > 1_048_576) {
      throw new Error("Review capture exceeds payload limit.");
    }
    // Capture only structured payloads, never prose or mutable tool-owned objects.
    const output: unknown = JSON.parse(serialized);
    return { failed: false as const, output };
  };
  const jobs = plan.reviewers.flatMap((reviewer) =>
    plan.reviewerPanel.map((entry) => ({ reviewer, ...entry })),
  );
  const raw: ReviewRawResult = { reviewerRuns: [] };
  const validatedRuns: ReviewRunOutcome[] = [];
  for (
    let offset = 0;
    offset < jobs.length;
    offset += REVIEW_WORKFLOW_CONCURRENCY
  ) {
    checkAbort(signal);
    const settled = await Promise.allSettled(
      jobs
        .slice(offset, offset + REVIEW_WORKFLOW_CONCURRENCY)
        .map(async (job) => {
          try {
            const call = await invoke(
              job.reviewer,
              job.model,
              job.thinkingLevel,
              buildReviewerPrompt(plan, job),
              reviewerSchema(job.reviewer),
            );
            const rawRun = {
              ...job,
              status: call.failed
                ? ("failed" as const)
                : ("succeeded" as const),
              ...(call.failed ? {} : { output: call.output }),
            };
            const parsed = call.failed
              ? undefined
              : validatePortableReviewer(call.output);
            const output = parsed?.ok
              ? (parsed.value as ReviewerJsonContract)
              : undefined;
            const validatedRun: ReviewRunOutcome =
              output?.reviewer === job.reviewer
                ? { ...job, status: "succeeded", output }
                : {
                    ...job,
                    status: "failed",
                    error: call.failed
                      ? "Agent run failed."
                      : "Invalid structured output after child reporting backstop.",
                  };
            return { rawRun, validatedRun };
          } catch (error) {
            controller.abort();
            throw error;
          }
        }),
    );
    for (const entry of settled) {
      if (entry.status === "rejected") {
        throw new Error("Review child capture failed or was cancelled.");
      }
      raw.reviewerRuns.push(entry.value.rawRun);
      validatedRuns.push(entry.value.validatedRun);
    }
  }
  checkAbort(signal);
  if (
    plan.reviewers.some(
      (role) =>
        !validatedRuns.some(
          (run) => run.reviewer === role && run.status === "succeeded",
        ),
    )
  ) {
    throw new Error(
      "No successful model run for every selected reviewer role.",
    );
  }
  const candidates = buildPortableCandidateFindings(
    validatedRuns,
  ) as ReviewCandidateFindingContract[];
  if (candidates.length) {
    const synthesis = await invoke(
      "review-synthesizer",
      plan.synthesizerModel,
      "medium",
      buildSynthesizerPrompt(plan, candidates),
      synthesizerSchema(),
    );
    if (synthesis.failed) {
      throw new Error("Review synthesizer agent run failed.");
    }
    raw.synthesizerOutput = synthesis.output;
    const parsed = parsePortableSynthesizerOutput(synthesis.output, candidates);
    if (!parsed.ok) {
      throw new Error("Invalid synthesizer output.");
    }
    const verification = await invoke(
      "review-verifier",
      plan.verifierModel,
      "medium",
      buildVerifierPrompt(
        plan,
        candidates,
        parsed.value as SynthesizedClusterContract[],
      ),
      verifierSchema(),
    );
    if (
      verification.failed ||
      !validatePortableVerifier(verification.output, candidates).ok
    ) {
      throw new Error("Invalid verifier output or failed verifier run.");
    }
    raw.verifierOutput = verification.output;
  }
  checkAbort(signal);
  derivePreparedReviewResult(plan, JSON.stringify(raw));
  return raw;
}
