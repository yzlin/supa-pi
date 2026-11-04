import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createTwoFilesPatch } from "diff";
import { Type } from "typebox";

import {
  allChecked,
  appendSpecEvents,
  deleteSnapshotRefs,
  deriveSpecState,
  doneCriteria,
  hashSpec,
  lintSpec,
  logAccepted,
  parseSpecPath,
  readSpecLog,
  renderSpecStatus,
  SPECS_DIR,
  type SpecLogEvent,
  snapshotWorkspace,
  validSlug,
} from "./spec";

export const SPEC_LOG_TOOL_NAME = "spec_log";
export const SPEC_STATUS_MESSAGE_TYPE = "spec-status";
const TO_SPEC_PREAMBLE =
  "Use the `to-spec` skill as canonical for this explicit command.";
const INVALID_SLUG =
  "Invalid Spec slug. Use 1–48 lowercase letters, digits or hyphens, starting with a letter or digit; status is reserved.";

const ACTIONS = [
  "lint",
  "status",
  "review",
  "accept",
  "check",
  "block",
  "stop",
] as const;
type Action = (typeof ACTIONS)[number];

export const SpecLogParametersSchema = Type.Object({
  action: Type.Union(ACTIONS.map((action) => Type.Literal(action))),
  specPath: Type.String({
    description: "Workspace-relative `.pi/specs/<slug>.md`.",
  }),
  id: Type.Optional(
    Type.String({
      description: "Done Criterion ID (DC-n) for check, or optionally block.",
    }),
  ),
  evidence: Type.Optional(
    Type.String({
      description:
        "check: the command run and its observed result, or the file inspected.",
    }),
  ),
  reason: Type.Optional(Type.String({ description: "block / stop reason." })),
  decision: Type.Optional(
    Type.Union([
      Type.Literal("accept"),
      Type.Literal("revise"),
      Type.Literal("stop"),
    ]),
  ),
  findings: Type.Optional(Type.Integer({ minimum: 0 })),
  revise: Type.Optional(
    Type.Boolean({
      description:
        "accept only: true re-accepts an already accepted Spec whose text changed, after the user approved the shown diff.",
    }),
  ),
});
interface Params {
  action: Action;
  specPath: string;
  id?: string;
  evidence?: string;
  reason?: string;
  decision?: "accept" | "revise" | "stop";
  findings?: number;
  revise?: boolean;
}

function nonBlank(value: string | undefined): value is string {
  return typeof value === "string" && /\S/u.test(value);
}

function result(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: {}, isError };
}

function revisionDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(
    `${path} (accepted)`,
    `${path} (current)`,
    before,
    after,
    "",
    "",
    { context: 2 },
  );
}

/** Runs one spec_log action. Exported for tests; the tool wraps it. */
export function runSpecLog(
  cwd: string,
  params: Params,
  now = () => new Date().toISOString(),
): { text: string; isError: boolean } {
  const fail = (text: string) => ({ text, isError: true });
  let paths: ReturnType<typeof parseSpecPath>;
  try {
    paths = parseSpecPath(params.specPath);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const absSpec = join(cwd, paths.specPath);
  const absLog = join(cwd, paths.logPath);
  if (params.action === "status") {
    return { text: renderSpecStatus(cwd, paths.slug), isError: false };
  }
  if (!existsSync(absSpec)) {
    return fail(`Spec not found: ${paths.specPath}`);
  }
  const content = readFileSync(absSpec, "utf8");
  const problems = lintSpec(content);
  if (params.action === "lint") {
    return problems.length
      ? fail(`Spec lint failed:\n- ${problems.join("\n- ")}`)
      : { text: `Spec lint passed: ${paths.specPath}`, isError: false };
  }
  let events: SpecLogEvent[];
  try {
    events = readSpecLog(absLog);
  } catch (error) {
    return fail(
      `${error instanceof Error ? error.message : String(error)} Report it; do not edit or bypass the log.`,
    );
  }
  const state = deriveSpecState(events);
  const hash = hashSpec(content);
  const append = (...items: SpecLogEvent[]) => appendSpecEvents(absLog, items);
  const ts = now();

  if (params.action === "review") {
    if (!params.decision || params.findings === undefined) {
      return fail("review requires decision and findings.");
    }
    append({
      ts,
      event: "reviewed",
      hash,
      decision: params.decision,
      findings: params.findings,
    });
    return {
      text: `Recorded Spec review: ${params.decision} (${params.findings} findings).`,
      isError: false,
    };
  }

  if (params.action === "accept") {
    if (problems.length) {
      return fail(
        `Spec lint failed; fix the Spec first:\n- ${problems.join("\n- ")}`,
      );
    }
    if (state.phase === "done") {
      return fail("Spec is done; draft a new Spec with a new slug.");
    }
    const latestReview = events.findLast(
      (event) => event.event === "reviewed" && event.hash === hash,
    );
    if (
      latestReview?.event === "reviewed" &&
      latestReview.decision !== "accept"
    ) {
      return fail(
        `The latest review of this Spec text decided ${latestReview.decision}; revise the Spec before accepting.`,
      );
    }
    const criteria = doneCriteria(content).map((row) => row.id);
    if (state.accepted) {
      if (state.accepted.hash === hash) {
        return {
          text: `Spec already accepted; continue.\n${renderSpecStatus(cwd, paths.slug)}`,
          isError: false,
        };
      }
      const diff = revisionDiff(
        paths.specPath,
        state.accepted.content,
        content,
      );
      if (!params.revise) {
        return fail(
          `The accepted Spec changed. Show this diff to the user and ask; on approval call accept with revise: true, otherwise restore the accepted text.\n\n${diff}`,
        );
      }
      append(
        { ts, event: "revised", hash, previousHash: state.accepted.hash },
        { ts, event: "accepted", hash, criteria, content },
      );
      return {
        text: `Re-accepted revised Spec. Every Done Criterion is open again; verify each one fresh.\n\n${diff}`,
        isError: false,
      };
    }
    append({ ts, event: "accepted", hash, criteria, content });
    return {
      text: `Accepted ${paths.specPath} with ${criteria.length} Done Criteria.`,
      isError: false,
    };
  }

  if (!state.accepted) {
    return fail(
      `${params.action} requires an accepted Spec; call accept first.`,
    );
  }
  if (state.phase === "done" || state.phase === "stopped") {
    return fail(`Spec is ${state.phase}; no further events.`);
  }
  if (hash !== state.accepted.hash) {
    return fail(
      `The Spec file changed since acceptance. Restore it, or show the diff, get user approval, and accept with revise: true.\n\n${revisionDiff(paths.specPath, state.accepted.content, content)}`,
    );
  }

  if (params.action === "check") {
    if (!(params.id && state.criteria.has(params.id))) {
      return fail(
        `check requires id: one of ${[...state.criteria.keys()].join(", ")}.`,
      );
    }
    if (!nonBlank(params.evidence)) {
      return fail(
        "check requires evidence: the command you ran and its observed result, or the file you inspected.",
      );
    }
    append({
      ts,
      event: "checked",
      id: params.id,
      evidence: params.evidence.trim(),
      ...snapshotWorkspace(cwd, paths.slug, state.checkedCount + 1),
    });
    const after = deriveSpecState(readSpecLog(absLog));
    let suffix = "";
    if (allChecked(after)) {
      append({ ts, event: "done" });
      try {
        deleteSnapshotRefs(cwd, paths.slug);
      } catch (error) {
        suffix = `\nSnapshot cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return {
      text: `${renderSpecStatus(cwd, paths.slug)}${suffix}`,
      isError: false,
    };
  }

  if (params.action === "block") {
    if (!nonBlank(params.reason)) {
      return fail("block requires reason.");
    }
    if (params.id !== undefined && !state.criteria.has(params.id)) {
      return fail(`Unknown Done Criterion: ${params.id}`);
    }
    append({
      ts,
      event: "blocked",
      ...(params.id ? { id: params.id } : {}),
      reason: params.reason.trim(),
    });
    return { text: renderSpecStatus(cwd, paths.slug), isError: false };
  }

  if (!nonBlank(params.reason)) {
    return fail("stop requires reason.");
  }
  append({ ts, event: "stopped", reason: params.reason.trim() });
  return { text: renderSpecStatus(cwd, paths.slug), isError: false };
}

function send(pi: ExtensionAPI, ctx: ExtensionContext, message: string): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(message);
    return;
  }
  pi.sendUserMessage(message, { deliverAs: "followUp" });
  ctx.ui.notify("Queued /to-spec as a follow-up", "info");
}

export default function specLogExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: SPEC_LOG_TOOL_NAME,
    label: "Spec log",
    description:
      "Only writer of `.pi/specs/<slug>.log.jsonl`. lint checks Spec shape; status shows checkboxes; review records a Spec review decision; accept records the accepted Spec (revise: true after a user-approved change); check records one verified Done Criterion with the evidence you observed and snapshots the workspace; block and stop record blockers. Writes `done` when every criterion is checked.",
    parameters: SpecLogParametersSchema,
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const outcome = runSpecLog(ctx.cwd, params as Params);
      return Promise.resolve(result(outcome.text, outcome.isError));
    },
  });

  pi.registerCommand("to-spec", {
    description:
      "Persist the locked plan as a Spec, or show progress: /to-spec [slug] [instructions] | /to-spec status [slug]",
    handler(args, ctx) {
      const input = (args ?? "").trim();
      const [slug = ""] = input.split(/\s+/u);
      const rest = input.slice(slug.length).trim();
      if (slug === "status") {
        pi.sendMessage({
          customType: SPEC_STATUS_MESSAGE_TYPE,
          content: renderSpecStatus(ctx.cwd, rest || undefined),
          display: true,
        });
        return Promise.resolve();
      }
      if (slug && !validSlug(slug)) {
        ctx.ui.notify(INVALID_SLUG, "error");
        return Promise.resolve();
      }
      if (slug && logAccepted(join(ctx.cwd, SPECS_DIR, `${slug}.log.jsonl`))) {
        ctx.ui.notify(
          `Spec ${slug} was already accepted; choose a new slug`,
          "error",
        );
        return Promise.resolve();
      }
      const packet = [
        TO_SPEC_PREAMBLE,
        `Slug: ${slug || "derive one from the goal"}`,
      ];
      if (slug && existsSync(join(ctx.cwd, SPECS_DIR, `${slug}.md`))) {
        packet.push(
          `Existing unaccepted Spec: ${SPECS_DIR}/${slug}.md — confirm overwrite with the user before writing.`,
        );
      }
      if (rest) {
        packet.push(rest);
      }
      send(pi, ctx, packet.join("\n\n"));
      return Promise.resolve();
    },
  });
}
