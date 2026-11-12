/**
 * Tier guard: makes the triage Playbook's Tier line and T2 Spec gate hold.
 *
 * Live triage evals (2026-11-11, .pi/specs/triage-sizing.md) showed the prose
 * rule alone is unreliable: 2 of 4 contract runs wrote the `Tier:` line only
 * in the final reply, and one sized T2 but edited code without accepting a
 * Spec. This hook refuses the work call instead.
 *
 * Scope: only the current user turn, and only after a `read` of
 * `skills/supapi-mode/playbooks/triage.md` in it (greps and edits of the
 * file do not count). A `read` of a non-build Playbook after triage turns
 * the guard off for the turn. Triage sizes the `execute` kind T2.
 * Work calls: `edit`, `write`, and `subagent` with agent `executor`.
 * A tier is declared by a `tier` tool call (registered here) or by a text
 * line `Tier: T<n>`. The tool exists because Claude 5 models (Opus 5.5 among
 * them) can return prose written between tool calls as a server-summarized
 * thinking block; session 01a1ca94 lost its Tier line that way and the guard
 * refused the Spec write 8 times. Tool arguments are never summarized.
 * - No tier yet: refuse.
 * - Latest tier is T2: refuse work outside `.pi/specs/` until a
 *   `spec_log` `accept` after that declaration succeeds.
 * Best-effort only: bash writes pass, and a later turn starts clean.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TRIAGE_PATH = "supapi-mode/playbooks/triage.md";
const NON_BUILD =
  /supapi-mode\/playbooks\/(?:investigation|diagnose|prototype|correct|fix-review-findings|opening-a-pr)\.md$/u;
// Same rule as the eval scorer (evals/paired-path/run.ts TIER_LINE).
const TIER_LINE = /^Tier: T(\d)\b/gmu;
export const TIER_TOOL = "tier";

/**
 * The tier a `tier` call declares, or undefined when its arguments are
 * invalid. Same rule as the eval scorer (evals/paired-path/run.ts tierArg).
 * It counts before its result arrives: a later call in the same message can
 * reach the tool_call hook first.
 */
function tierArg(args: Record<string, unknown>): number | undefined {
  const { tier, reason } = args;
  return typeof tier === "number" &&
    Number.isInteger(tier) &&
    tier >= 0 &&
    tier <= 3 &&
    typeof reason === "string" &&
    reason.trim() !== ""
    ? tier
    : undefined;
}

type Part = Record<string, unknown>;
interface Item {
  kind: "user" | "text" | "tool" | "result";
  text?: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
}

/** Flatten branch entries into user prompts, assistant parts, and tool results. */
export function flatten(entries: unknown[]): Item[] {
  const items: Item[] = [];
  for (const entry of entries as { type?: string; message?: Part }[]) {
    const message = entry.message;
    if (entry.type !== "message" || !message) {
      continue;
    }
    if (message.role === "user") {
      items.push({ kind: "user" });
    } else if (message.role === "toolResult") {
      items.push({
        kind: "result",
        id: message.toolCallId as string,
        isError: message.isError === true,
      });
    } else if (message.role === "assistant") {
      for (const part of (message.content as Part[] | undefined) ?? []) {
        if (part.type === "text" && typeof part.text === "string") {
          items.push({ kind: "text", text: part.text });
        } else if (part.type === "toolCall") {
          items.push({
            kind: "tool",
            id: part.id as string,
            name: part.name as string,
            args: (part.arguments as Record<string, unknown>) ?? {},
          });
        }
      }
    }
  }
  return items;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function reads(item: Item, pattern: string | RegExp): boolean {
  if (item.kind !== "tool" || item.name !== "read") {
    return false;
  }
  const path = str(item.args?.path);
  return typeof pattern === "string"
    ? path.endsWith(pattern)
    : pattern.test(path);
}

function isWork(name: string, input: Record<string, unknown>): boolean {
  return (
    name === "edit" ||
    name === "write" ||
    (name === "subagent" && input.agent === "executor")
  );
}

/** Resolve symlinks in the longest existing prefix of `path`. */
function real(path: string): string {
  let head = path;
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  return join(existsSync(head) ? realpathSync(head) : head, ...tail);
}

function inSpecs(input: Record<string, unknown>, cwd: string): boolean {
  const path = real(resolve(cwd, str(input.path)));
  return path.startsWith(`${real(resolve(cwd, ".pi/specs"))}${sep}`);
}

/**
 * The refusal reason for a work call, or null to allow it. `items` must end at
 * or include the call (`callId`); later items are ignored.
 */
export function tierRefusal(
  items: Item[],
  callId: string,
  name: string,
  input: Record<string, unknown>,
  cwd = process.cwd(),
): string | null {
  if (!isWork(name, input)) {
    return null;
  }
  const end = items.findIndex((i) => i.kind === "tool" && i.id === callId);
  const before = end === -1 ? items : items.slice(0, end);
  const turnStart = before.findLastIndex((i) => i.kind === "user") + 1;
  const turn = before.slice(turnStart);
  const triage = turn.findLastIndex((i) => reads(i, TRIAGE_PATH));
  if (triage === -1) {
    return null;
  }
  const after = turn.slice(triage + 1);
  let tier: { tier: number; at: number } | undefined;
  for (const [at, item] of after.entries()) {
    if (reads(item, NON_BUILD)) {
      return null;
    }
    if (item.kind === "tool" && item.name === TIER_TOOL) {
      const declared = tierArg(item.args ?? {});
      if (declared !== undefined) {
        tier = { tier: declared, at };
      }
      continue;
    }
    if (item.kind !== "text") {
      continue;
    }
    for (const match of (item.text ?? "").matchAll(TIER_LINE)) {
      tier = { tier: Number(match[1]), at };
    }
  }
  if (!tier) {
    return [
      "Refused by the tier guard: no Tier line yet.",
      "",
      "Triage step 6: before the first edit, write, or executor call, call the",
      "`tier` tool with the tier and the hard trigger or soft signals that set",
      "it (or, without that tool, write a line that starts with `Tier: T<n> — `).",
      "Then retry this call.",
      "",
    ].join("\n");
  }
  // At T2, Spec files stay writable so the agent can reach the accept; a
  // successful accept after the T2 line opens other work.
  if (
    tier.tier !== 2 ||
    inSpecs(input, cwd) ||
    accepted(after.slice(tier.at + 1))
  ) {
    return null;
  }
  return [
    "Refused by the tier guard: tier T2 has no accepted Spec yet.",
    "",
    "Triage step 7: at T2, write the Spec under `.pi/specs/` and run the",
    "`execute` Playbook through `spec_log` `accept` before you change other",
    "files or delegate to an executor. Then retry this call.",
    "",
  ].join("\n");
}

function accepted(items: Item[]): boolean {
  return items.some(
    (call) =>
      call.kind === "tool" &&
      call.name === "spec_log" &&
      call.args?.action === "accept" &&
      items.some(
        (r) => r.kind === "result" && r.id === call.id && r.isError !== true,
      ),
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: TIER_TOOL,
    label: "Tier",
    description:
      "Declare the triage size tier (T0–T3) and the hard trigger or soft signals that set it. Call once after sizing, before the first edit, write, or executor call; call again to escalate. T0 only when a search finds no other reader of the changed line; a change other code reads is T1 or higher.",
    parameters: Type.Object({
      tier: Type.Integer({ minimum: 0, maximum: 3, description: "Tier 0–3" }),
      reason: Type.String({
        minLength: 1,
        description: "The hard trigger or soft signals that set the tier",
      }),
    }),
    async execute(_id, params) {
      return {
        content: [
          { type: "text", text: `Tier: T${params.tier} — ${params.reason}` },
        ],
        details: {},
      };
    },
  });
  pi.on("tool_call", (event, ctx) => {
    const reason = tierRefusal(
      flatten(ctx.sessionManager.getBranch() as unknown[]),
      event.toolCallId,
      event.toolName,
      event.input as Record<string, unknown>,
      ctx.cwd,
    );
    if (reason) {
      return { block: true, reason };
    }
  });
}
