import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ReviewTarget } from "../shared/review-targets";
import { deriveJournalReviewResult } from "./finalization";
import { captureReviewTargetFreshness } from "./freshness";
import {
  type PublicReviewWorkflowInput,
  prepareReviewWorkflowScript,
} from "./public-workflow";
import { type ReviewWorkflowResult, renderReviewReport } from "./workflow";

const MAX_ARTIFACT_BYTES = 1_048_576;
const NATIVE_ID = /^wf_[a-zA-Z0-9_-]{1,128}$/u;
const SCRIPT_LINE = /^Script: (\/[^\r\n\0]{1,4096})$/gmu;
const SCRIPT_SUFFIX = /\.js$/u;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

interface PendingRun {
  id: string;
  sessionId: string;
  cwd: string;
  target: ReviewTarget;
  fingerprint: string;
  plan: PublicReviewWorkflowInput;
  script: string;
  scriptHash: string;
  handoffScript: string;
  invalid: boolean;
  finalizing: boolean;
  published: boolean;
  toolCallId?: string;
  nativeId?: string;
  scriptPath?: string;
  detach: () => void;
}

/** Public artifacts are version-sensitive evidence, not a private upstream API. */
async function readArtifact(filename: string): Promise<string> {
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) {
    throw new Error("Unsafe review artifact path.");
  }

  // The public workflow writes under the OS temporary directory. On macOS,
  // /tmp and /private/tmp are aliases, so containment must use the resolved
  // temporary root while the component walk still rejects arbitrary links.
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const resolvedFilename = await fs.realpath(filename);
  const relative = path.relative(temporaryRoot, resolvedFilename);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Unsafe review artifact path.");
  }

  const configuredTemporaryRoot = path.resolve(os.tmpdir());
  const temporaryAliases = new Set([temporaryRoot]);
  // os.tmpdir() may itself use a trusted platform alias (for example
  // /var/folders on macOS, where /var resolves to /private/var). Permit only
  // symlinks in that bound root prefix; descendants remain untrusted.
  if ((await fs.realpath(configuredTemporaryRoot)) === temporaryRoot) {
    let aliasAncestor = configuredTemporaryRoot;
    while (true) {
      temporaryAliases.add(aliasAncestor);
      const parent = path.dirname(aliasAncestor);
      if (parent === aliasAncestor) {
        break;
      }
      aliasAncestor = parent;
    }
  }
  for (const alias of ["/tmp", "/private/tmp"]) {
    const resolvedAlias = await fs.realpath(alias).catch(() => null);
    if (resolvedAlias === temporaryRoot) {
      temporaryAliases.add(alias);
    }
  }

  // Reject symlinks in every component except a canonical OS-temp alias.
  // realpath equality alone misses self links, and allowing arbitrary links
  // inside the temp tree would reintroduce an escape through a nested alias.
  let ancestor = filename;
  while (true) {
    const stats = await fs.lstat(ancestor);
    if (
      stats.isSymbolicLink() &&
      !temporaryAliases.has(path.normalize(ancestor))
    ) {
      throw new Error("Unsafe review artifact symlink.");
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    ancestor = parent;
  }
  const handle = await fs.open(
    filename,
    constants.O_RDONLY + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_ARTIFACT_BYTES) {
      throw new Error("Unsupported review artifact size/type.");
    }
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) {
        break;
      }
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("Review artifact changed during capture.");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, offset),
    );
  } finally {
    await handle.close();
  }
}

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
      run.detach();
    }
    return `Review cancelled; no report will be published.${run?.nativeId ? ` Stop native workflow ${run.nativeId} via /agents Workflows.` : " Stop any dispatched workers via /agents Workflows."}`;
  }

  async prepare(
    ctx: ExtensionContext,
    target: ReviewTarget,
    plan: PublicReviewWorkflowInput,
    signal?: AbortSignal,
  ): Promise<Readonly<{ id: string; script: string }>> {
    if (this.running || this.preparing) {
      throw new Error("A review is already running.");
    }
    this.preparing = true;
    try {
      const generation = this.generation;
      const parentSignal = ctx.signal;
      const sessionId = ctx.sessionManager.getSessionId();
      const cwd = ctx.cwd;
      const savedTarget = structuredClone(target);
      const savedPlan = structuredClone(plan);
      const script = prepareReviewWorkflowScript(savedPlan);
      const fingerprint = await captureReviewTargetFreshness(cwd, savedTarget, {
        signal,
      });
      if (
        signal?.aborted ||
        parentSignal?.aborted ||
        generation !== this.generation ||
        sessionId !== ctx.sessionManager.getSessionId() ||
        cwd !== ctx.cwd
      ) {
        throw new Error("Review preparation cancelled or session changed.");
      }
      const abort = () => {
        this.cancel();
      };
      const id = randomUUID();
      const scriptHash = digest(script);
      const handoffScript = `/* supa-pi-review:${id}:${scriptHash} */`;
      const run: PendingRun = {
        id,
        sessionId,
        cwd,
        target: savedTarget,
        plan: savedPlan,
        script,
        scriptHash,
        handoffScript,
        fingerprint: fingerprint.digest,
        invalid: false,
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
      return Object.freeze({ id: run.id, script: handoffScript });
    } finally {
      this.preparing = false;
    }
  }

  dispatch(
    event: {
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
    },
    ctx: ExtensionContext,
  ): { block: true; reason: string } | undefined {
    const run = this.pending;
    if (!run || event.toolName !== "SubagentWorkflow") {
      return;
    }
    if (
      !this.running &&
      event.input.script !== run.handoffScript &&
      event.input.script !== run.script
    ) {
      return;
    }
    // While a review is pending, no alternate native call can stand in for it.
    if (
      !this.running ||
      run.toolCallId ||
      Object.keys(event.input).some((key) => key !== "script") ||
      event.input.script !== run.handoffScript ||
      digest(run.script) !== run.scriptHash ||
      !this.sameContext(run, ctx)
    ) {
      this.cancel();
      return {
        block: true,
        reason:
          "Review requires exactly one unchanged prepared SubagentWorkflow marker, with no alternate arguments. Run /review again.",
      };
    }
    // Pi's public tool_call contract applies input mutations before execution.
    // Expand only the bound marker; native artifacts still capture the full source.
    event.input.script = run.script;
    run.toolCallId = event.toolCallId;
  }

  result(
    event: {
      toolName: string;
      toolCallId: string;
      isError?: boolean;
      details?: unknown;
      content?: unknown;
    },
    ctx: ExtensionContext,
  ): void {
    const run = this.pending;
    if (!run || event.toolName !== "SubagentWorkflow") {
      return;
    }
    if (!this.running && event.toolCallId !== run.toolCallId) {
      return;
    }
    if (
      !this.running ||
      run.nativeId ||
      !run.toolCallId ||
      event.toolCallId !== run.toolCallId ||
      event.isError ||
      !this.sameContext(run, ctx)
    ) {
      this.cancel();
      return;
    }
    const details = event.details as { taskId?: unknown } | undefined;
    const text = Array.isArray(event.content)
      ? event.content
          .flatMap((part) =>
            part?.type === "text" && typeof part.text === "string"
              ? [part.text]
              : [],
          )
          .join("\n")
      : "";
    const paths =
      text.length <= 32_768
        ? [...text.matchAll(SCRIPT_LINE)].map((match) => match[1])
        : [];
    if (
      typeof details?.taskId !== "string" ||
      !NATIVE_ID.test(details.taskId) ||
      paths.length !== 1 ||
      path.basename(paths[0]) !== `${details.taskId}.workflow.js` ||
      path.normalize(paths[0]) !== paths[0]
    ) {
      this.cancel();
      return;
    }
    run.nativeId = details.taskId;
    run.scriptPath = paths[0];
  }

  private sameContext(run: PendingRun, ctx: ExtensionContext): boolean {
    return (
      !(run.invalid || run.published || ctx.signal?.aborted) &&
      ctx.cwd === run.cwd &&
      ctx.sessionManager.getSessionId() === run.sessionId
    );
  }

  private assertReady(run: PendingRun, ctx: ExtensionContext): void {
    if (!this.sameContext(run, ctx)) {
      this.cancel();
      throw new Error(
        "Review cancelled, already published, or session/cwd changed.",
      );
    }
    let completed = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom_message") {
        continue;
      }
      const message = entry;
      const details = message.details as
        | { id?: unknown; status?: unknown }
        | undefined;
      if (
        message.customType !== "subagent-notification" ||
        !run.nativeId ||
        details?.id !== run.nativeId
      ) {
        continue;
      }
      if (details.status !== "completed") {
        this.cancel();
        throw new Error("Native review workflow stopped or failed.");
      }
      completed = true;
    }
    if (!(completed && run.scriptPath)) {
      throw new Error(
        "Review not ready: missing completed native workflow or supported startup capture.",
      );
    }
  }

  async finalize(
    runId: string,
    ctx: ExtensionContext,
    publish: (result: ReviewWorkflowResult) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const run = this.pending;
    if (
      !run ||
      run.id !== runId ||
      run.finalizing ||
      run.published ||
      run.invalid
    ) {
      throw new Error(
        "Unknown, invalid, replayed, or concurrently finalizing review run.",
      );
    }
    this.assertReady(run, ctx);
    run.finalizing = true;
    const abort = () => {
      this.cancel();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) {
        throw new Error("Review finalization cancelled.");
      }
      const before = await captureReviewTargetFreshness(run.cwd, run.target, {
        signal,
      });
      this.assertReady(run, ctx);
      if (before.digest !== run.fingerprint) {
        throw new Error("Review target is stale; run /review again.");
      }
      const scriptPath = run.scriptPath;
      if (!scriptPath) {
        throw new Error("Missing native startup script capture.");
      }
      const script = await readArtifact(scriptPath);
      if (script !== run.script || digest(script) !== run.scriptHash) {
        throw new Error(
          "Saved native review script differs from authorized source.",
        );
      }
      const journal = await readArtifact(
        scriptPath.replace(SCRIPT_SUFFIX, ".jsonl"),
      );
      this.assertReady(run, ctx);
      const result = deriveJournalReviewResult(run.plan, journal);
      const after = await captureReviewTargetFreshness(run.cwd, run.target, {
        signal,
      });
      this.assertReady(run, ctx);
      if (signal?.aborted || after.digest !== run.fingerprint) {
        throw new Error("Review target changed or finalization cancelled.");
      }
      const report = renderReviewReport(result.verifier, result.coverage);
      run.published = true;
      run.detach();
      publish({ ...result, report });
    } catch (error) {
      this.cancel();
      throw new Error(
        `Review finalization failed (unsupported/missing capture or invalid run): ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      run.finalizing = false;
      signal?.removeEventListener("abort", abort);
    }
  }
}
