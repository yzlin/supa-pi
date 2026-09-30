import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { Skill } from "@earendil-works/pi-coding-agent";

import {
  type JevBatchResult,
  type JevCandidate,
  ROUTING_DEADLINE_MS,
} from "./jev";
import { EXPLICIT_ONLY_SKILLS } from "./policy";

export const MAX_SKILLS = 256;
export const MAX_TEXT_BYTES = 8192;
export const MAX_SELECTED = 8;
export const MAX_SELECTED_BODY_BYTES = 65_536;
export const SELECT_THRESHOLD = 0.9;
export const REJECT_THRESHOLD = 0.1; // Provisional and intentionally conservative; not calibrated.
export interface RouteCandidate extends JevCandidate {
  skill: Skill;
}
export type PreparedRoute =
  | {
      ok: true;
      candidates: RouteCandidate[];
      context: { currentRequest: string; recentText: string };
    }
  | { ok: false; reason: string };
export type RouteResult =
  | {
      kind: "selected";
      skills: Skill[];
      usage: { attempts: number; inputTokens: number; outputTokens: number };
    }
  | {
      kind: "fallback";
      reason: string;
      usage: { attempts: number; inputTokens: number; outputTokens: number };
    };
export function prepareRoute(input: {
  skills: readonly Skill[];
  currentRequest: string;
  recentText: string;
}): PreparedRoute {
  if (input.skills.length > MAX_SKILLS) {
    return { ok: false, reason: "skill limit exceeded" };
  }
  if (bytes(input.currentRequest) > MAX_TEXT_BYTES) {
    return { ok: false, reason: "request limit exceeded" };
  }
  const candidates: RouteCandidate[] = [];
  for (const [index, skill] of input.skills.entries()) {
    if (bytes(skill.name) > 64 || bytes(skill.description) > 1024) {
      return { ok: false, reason: "skill metadata limit exceeded" };
    }
    if (skill.disableModelInvocation || EXPLICIT_ONLY_SKILLS.has(skill.name)) {
      continue;
    }
    candidates.push({
      id: `s${index}`,
      name: skill.name,
      description: skill.description,
      skill,
    });
  }
  return {
    ok: true,
    candidates,
    context: {
      currentRequest: input.currentRequest,
      recentText: truncateVisible(input.recentText, MAX_TEXT_BYTES),
    },
  };
}
export async function classifyRoute(
  prepared: Extract<PreparedRoute, { ok: true }>,
  judge: (
    batch: readonly JevCandidate[],
    context: { currentRequest: string; recentText: string },
    signal?: AbortSignal,
  ) => Promise<JevBatchResult>,
  signal?: AbortSignal,
): Promise<RouteResult> {
  const usage = { attempts: 0, inputTokens: 0, outputTokens: 0 };
  const snapshot = () => ({ ...usage });
  if (signal?.aborted) {
    return { kind: "fallback", reason: "cancelled", usage: snapshot() };
  }
  if (prepared.candidates.length === 0) {
    return { kind: "selected", skills: [], usage: snapshot() };
  }
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("routing deadline exceeded"));
  }, ROUTING_DEADLINE_MS);
  const batches: RouteCandidate[][] = [];
  for (let i = 0; i < prepared.candidates.length; i += 16) {
    batches.push(prepared.candidates.slice(i, i + 16));
  }
  let next = 0;
  const results = new Map<string, number>();
  let failure = false;
  const worker = async () => {
    while (next < batches.length && !failure) {
      if (controller.signal.aborted) {
        failure = true;
        return;
      }
      const batch = batches[next++];
      usage.attempts += batch.length;
      try {
        const result = await judge(batch, prepared.context, controller.signal);
        usage.inputTokens += result.inputTokens ?? 0;
        usage.outputTokens += result.outputTokens ?? 0;
        for (const item of batch) {
          const score = result.scores.get(item.id);
          if (score === undefined) {
            failure = true;
            return;
          }
          results.set(item.id, score);
        }
      } catch {
        failure = true;
        return;
      }
    }
  };
  let settleAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    settleAbort = () => resolve();
    controller.signal.addEventListener("abort", settleAbort, { once: true });
    if (controller.signal.aborted) {
      settleAbort();
    }
  });
  const work = Promise.all(
    Array.from({ length: Math.min(4, batches.length) }, worker),
  );
  await Promise.race([work, aborted]);
  clearTimeout(timeout);
  controller.signal.removeEventListener("abort", settleAbort);
  signal?.removeEventListener("abort", forwardAbort);
  if (
    signal?.aborted ||
    timedOut ||
    failure ||
    results.size !== prepared.candidates.length
  ) {
    controller.abort();
    let reason = "classification failed";
    if (timedOut) {
      reason = "classification timed out";
    }
    if (signal?.aborted) {
      reason = "cancelled";
    }
    return { kind: "fallback", reason, usage: snapshot() };
  }
  const selected: Skill[] = [];
  for (const candidate of prepared.candidates) {
    const score = results.get(candidate.id);
    if (
      score === undefined ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    ) {
      return {
        kind: "fallback",
        reason: "malformed classification",
        usage: snapshot(),
      };
    }
    if (score > REJECT_THRESHOLD && score < SELECT_THRESHOLD) {
      return {
        kind: "fallback",
        reason: "uncertain classification",
        usage: snapshot(),
      };
    }
    if (score >= SELECT_THRESHOLD) {
      selected.push(candidate.skill);
    }
  }
  if (selected.length > MAX_SELECTED) {
    return {
      kind: "fallback",
      reason: "selection limit exceeded",
      usage: snapshot(),
    };
  }
  if (signal?.aborted) {
    return { kind: "fallback", reason: "cancelled", usage: snapshot() };
  }
  return { kind: "selected", skills: selected, usage: snapshot() };
}
export interface LoadedSkill {
  skill: Skill;
  body: string;
}
export async function loadSelectedSkills(
  available: readonly Skill[],
  names: readonly string[],
): Promise<
  { ok: true; skills: LoadedSkill[] } | { ok: false; reason: string }
> {
  if (names.length > MAX_SELECTED || new Set(names).size !== names.length) {
    return { ok: false, reason: "invalid selection" };
  }
  const byName = new Map(available.map((skill) => [skill.name, skill]));
  const loaded: LoadedSkill[] = [];
  let total = 0;
  try {
    for (const name of names) {
      const skill = byName.get(name);
      if (!skill) {
        return { ok: false, reason: "unknown selection" };
      }
      const remaining = MAX_SELECTED_BODY_BYTES - total;
      // O_NONBLOCK ensures a configured FIFO cannot stall routing before fstat rejects it.
      // oxlint-disable-next-line no-bitwise -- file open flags are bit masks
      const flags = constants.O_RDONLY | constants.O_NONBLOCK;
      const handle = await open(skill.filePath, flags);
      let body: string;
      try {
        const info = await handle.stat();
        if (!info.isFile()) {
          return { ok: false, reason: "selected skill unreadable" };
        }
        if (info.size > remaining) {
          return { ok: false, reason: "selected body limit exceeded" };
        }
        const buffer = Buffer.alloc(remaining + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            offset,
            buffer.length - offset,
            offset,
          );
          if (bytesRead === 0) {
            break;
          }
          offset += bytesRead;
        }
        if (offset > remaining) {
          return { ok: false, reason: "selected body limit exceeded" };
        }
        const after = await handle.stat();
        if (
          !after.isFile() ||
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          offset !== after.size
        ) {
          return { ok: false, reason: "selected skill unreadable" };
        }
        body = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, offset),
        );
      } finally {
        await handle.close();
      }
      total += bytes(body);
      loaded.push({ skill, body });
    }
  } catch {
    return { ok: false, reason: "selected skill unreadable" };
  }
  return { ok: true, skills: loaded };
}
function bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}
function truncateVisible(value: string, limit: number): string {
  if (bytes(value) <= limit) {
    return value;
  }
  const marker = "[truncated: older recent text omitted]\n";
  const allowance = limit - bytes(marker);
  let start = value.length;
  let used = 0;
  for (const character of Array.from(value).reverse()) {
    const size = bytes(character);
    if (used + size > allowance) {
      break;
    }
    used += size;
    start -= character.length;
  }
  return marker + value.slice(start);
}
