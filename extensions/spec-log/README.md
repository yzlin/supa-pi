---
title: spec-log extension
read_when:
  - changing /to-spec, the spec_log tool, Spec format lint, Spec logs, Snapshot refs, or Spec resume
  - changing how the execute Playbook records Done Criteria
status: active
---

# `spec-log`

Since P4 (ADR 0005), `/execute` is a Playbook (`skills/supapi-mode/playbooks/execute.md`) and this extension is its only code. It owns two things: the `spec_log` tool, which is the only writer of `.pi/specs/<slug>.log.jsonl`, and the `/to-spec` command.

## `spec_log` tool

`spec_log({action, specPath, id?, evidence?, reason?, decision?, findings?, verdict?, revise?})`. `specPath` must be `.pi/specs/<slug>.md` (a leading `@` is accepted).

| action | effect |
| --- | --- |
| `lint` | Checks Spec shape: `# Execution Brief`; required sections in order (`Execution Scope`, `User Stories`, `Plan`, `Done Criteria`, `Live Lanes`, `Verification`, optional `Testing Seams`, `Out of Scope`); unique `- DC-n:` rows, each ending in `(US-n)` or `(technical)` and followed by an indented `Evidence:` line; story coverage in both directions; Live Lanes (below). |
| `status` | The checkbox view: `- [x]` checked with evidence, `- [~]` checked but stale (with `Stale: <files>`), `- [ ]` open, `- [!]` blocked with reason. |
| `review` | Records a Spec review `decision` (`accept`, `revise`, `stop`) and finding count for the current text. |
| `accept` | Lints, then records the accepted text, its SHA-256, its criteria, and the base snapshot (`head`, `snapshot: refs/pi-specs/<slug>/0`). A later `revise` or `stop` review of the same text blocks it. When an accepted Spec changed, it returns the diff and requires `revise: true` (after the user approves); that writes `revised` + `accepted`, keeps the first base snapshot, and reopens every criterion. |
| `check` | Records one Done Criterion as verified with non-blank evidence and a Snapshot ref. It never writes `done`. |
| `verify` | Records the `dc-verifier` verdict (`pass` or `issues`), confirmed `findings` count, and non-blank `evidence` as a `verified` event with a Snapshot ref. Every criterion must be checked first. `verify pass` is refused, and writes nothing, while any criterion is stale; otherwise `verify pass` writes `done` and deletes the Spec's Snapshot refs. `issues` writes no `done`. |
| `block` | Records a blocker for one criterion (`id`) or the whole plan. |
| `stop` | Records a stop; no further events. |

`check`, `verify`, `block`, and `stop` need an accepted Spec whose file still matches the accepted hash.

Snapshot refs: `accept` stores the base as `refs/pi-specs/<slug>/0`; each `check` and `verify` stores the working tree as the next `refs/pi-specs/<slug>/<n>` (one shared counter) through a temporary index, without changing the real index. Non-git workspaces store `null`.

Stale rule (ADR 0006): `status` writes the current working tree once and runs `git diff --name-only <snapshot>^{tree} <current> -- . ':(exclude).pi/specs'` for each checked criterion. Any output marks it `[~]`. `.pi/specs/` never counts, because `check` writes the Spec log right after its snapshot. The rule is whole-tree: any edit makes every earlier check stale, so the execute Playbook re-checks every criterion before `verify`. A check with no snapshot (or outside a git work tree) shows `Stale: unknown`, which does not block. When a check has a snapshot but git cannot write the current tree or compare with the ref (for example, the ref was deleted), the criterion shows `[~]` with `Stale: error: <message>`, and `verify pass` refuses it like a stale one. Done Specs have no refs and show no stale marks.

### Live Lanes

`## Live Lanes` is required unless `User Stories` is the `N/A — internal: <reason>` line, and is checked whenever present. Each row is `- LANE-n: <scenario> (DC-n)` with a unique label and at least one known `(DC-n)`, and indented `Drive:`, `Artifact:`, and `Pass when:` lines. A row ending in `(baseline)` also needs a `Baseline:` line, and a `Baseline:` line needs that tag. A Spec needs at least one lane; a baseline lane is optional, and the `to-spec` rules ask for one only when the change alters existing behavior. The `dc-verifier` agent (`agents/dc-verifier.md`, report schema `skills/supapi-mode/schemas/dc-verify.schema.json`) runs them at Finish; baseline lanes run in a detached worktree of the base snapshot.

Display: the tool has its own `renderCall` (`spec_log <action> <slug> [DC-n]`) and a `renderResult` that shows the result text as Markdown, cut to 20 lines until expanded. Result text is written as Markdown: a blank line before `Blocker:` lines ends the checkbox list, and revision diffs come in a `diff` fence longer than any backtick run in the diff, so code fences in the Spec cannot close it.

### What it does not check

It does not know who ran what. It accepts any non-blank evidence text and does not bind it to a tool call, a child run, scope, repair counts, or approval. It does not check that a `dc-verifier` ran, or that the `verdict` is the one it returned. Those gates are prose in the execute Playbook. This is the accepted risk in ADR 0005; ADR 0006 adds only the code gate that `verify pass` needs every criterion checked and none stale.

### Legacy logs

A log written before P4 by the `execute_checkpoint` runtime is valid JSON in another shape. `spec_log` reports it as `legacy (pre-P4): <last event>` in status and refuses every write. There is no import. Use a new slug.

## `/to-spec`

- `/to-spec [slug] [instructions]` sends a packet to the `to-spec` skill. Slugs are 1–48 lowercase letters, digits, or hyphens; `status` is reserved. A slug whose log has an `accepted` event, or whose log cannot be read, is refused. An existing unaccepted Spec is named so the skill asks before overwriting.
- `/to-spec status [slug]` prints `renderSpecStatus` as a `spec-status` message with no model turn. Without a slug it lists every Spec with its phase and `checked/total`.

## Files

- `spec.ts`: pure lint, log schema, read/append, state, Snapshot refs, and status rendering.
- `index.ts`: tool and command registration; `runSpecLog` holds the action logic for tests.
