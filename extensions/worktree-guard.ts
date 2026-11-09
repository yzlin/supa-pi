/**
 * Worktree guard: refuses agent bash calls that run `git worktree remove`.
 *
 * `git worktree remove` (with or without --force) deletes the directory
 * permanently. The repo rule is to move it to Trash and prune the record.
 * Agents broke that rule in prose form at least ten times (see
 * docs/context/enforced-rules.md), so the bash tool now refuses it.
 * Uses `tool_call` instead of registering `bash`, like extensions/uv.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// `git` at the start of a shell segment, optionally after command wrappers
// (sudo, env with VAR=value assignments, command, exec, time, nohup, xargs)
// or as a path such as /usr/bin/git. Then optional global options such as
// `-C <dir>`, then `worktree remove`. Quoted mentions (grep, git log -G,
// echo) do not start a segment with git, so they pass. Best-effort only: a
// shell can always hide the command (eval, aliases, scripts).
const worktreeRemovePattern =
  /(?:^|\n|[;|&(]{1,2})\s*(?:(?:sudo|env|command|exec|time|nohup|xargs)(?:\s+-\S+)*\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?git(?:\s+-[^\s]+(?:\s+[^\s-][^\s]*)?)*\s+worktree\s+remove\b/m;

export function getWorktreeRemoveMessage(command: string): string | null {
  if (!worktreeRemovePattern.test(command)) {
    return null;
  }
  return [
    "Error: `git worktree remove` is disabled; it deletes permanently.",
    "",
    "  Move the directory to Trash, then drop the record:",
    "  trash <worktree-dir> && git worktree prune",
    "",
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) {
      return;
    }
    const message = getWorktreeRemoveMessage(event.input.command);
    if (message) {
      return { block: true, reason: message };
    }
  });
}
