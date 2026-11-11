/**
 * Offline replay of the tier-guard loop from session 01a1ca94 (2026-11-11).
 *
 * Usage: bun evals/tier-tool/replay.ts <session.jsonl>
 *
 * Reads lines 1–214 (after the 7th refused Spec write), appends one Spec
 * `write`, and asks the workspace tier guard about it. Then inserts one `tier`
 * T2 call before the write and asks again. No model call; free and repeatable.
 */

import { readFileSync } from "node:fs";

import { flatten, tierRefusal } from "../../extensions/tier-guard";

const CUT = 214;
const CWD = "/Users/yzlin/dev/golfsavers/golfsavers-subsite";

const file = process.argv[2];
if (!file) {
  throw new Error("usage: bun evals/tier-tool/replay.ts <session.jsonl>");
}
const prefix: unknown[] = readFileSync(file, "utf8")
  .trim()
  .split("\n")
  .slice(0, CUT)
  .map((line) => JSON.parse(line) as unknown);

const input = { path: ".pi/specs/replay.md", content: "x" };
const assistant = (part: Record<string, unknown>) => ({
  type: "message",
  message: { role: "assistant", content: [part] },
});
const write = assistant({
  type: "toolCall",
  id: "replay-write",
  name: "write",
  arguments: input,
});
const tier = assistant({
  type: "toolCall",
  id: "replay-tier",
  name: "tier",
  arguments: { tier: 2, reason: "replay" },
});

const ask = (entries: unknown[]) =>
  tierRefusal(flatten(entries), "replay-write", "write", input, CWD) === null
    ? "allowed"
    : "refused";

console.log(`before: ${ask([...prefix, write])}`);
console.log(`after tier call: ${ask([...prefix, tier, write])}`);
