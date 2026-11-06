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

`spec_log({action, specPath, id?, evidence?, reason?, decision?, findings?, revise?})`. `specPath` must be `.pi/specs/<slug>.md` (a leading `@` is accepted).

| action | effect |
| --- | --- |
| `lint` | Checks Spec shape: `# Execution Brief`; required sections in order (`Execution Scope`, `User Stories`, `Plan`, `Done Criteria`, `Verification`, optional `Testing Seams`, `Out of Scope`); unique `- DC-n:` rows, each ending in `(US-n)` or `(technical)` and followed by an indented `Evidence:` line; story coverage in both directions. |
| `status` | The checkbox view: `- [x]` checked with evidence, `- [ ]` open, `- [!]` blocked with reason. |
| `review` | Records a Spec review `decision` (`accept`, `revise`, `stop`) and finding count for the current text. |
| `accept` | Lints, then records the accepted text, its SHA-256, and its criteria. A later `revise` or `stop` review of the same text blocks it. When an accepted Spec changed, it returns the diff and requires `revise: true` (after the user approves); that writes `revised` + `accepted` and reopens every criterion. |
| `check` | Records one Done Criterion as verified with non-blank evidence and a Snapshot ref. Writes `done` and deletes the Spec's Snapshot refs when every criterion is checked. |
| `block` | Records a blocker for one criterion (`id`) or the whole plan. |
| `stop` | Records a stop; no further events. |

`check`, `block`, and `stop` need an accepted Spec whose file still matches the accepted hash.

Snapshot refs: each `check` stores the working tree as `refs/pi-specs/<slug>/<n>` through a temporary index, without changing the real index.

Display: the tool has its own `renderCall` (`spec_log <action> <slug> [DC-n]`) and a `renderResult` that shows the result text as Markdown, cut to 20 lines until expanded. Result text is written as Markdown: a blank line before `Blocker:` lines ends the checkbox list, and revision diffs come in a `diff` fence longer than any backtick run in the diff, so code fences in the Spec cannot close it.

### What it does not check

It does not know who ran what. It accepts any non-blank evidence text and does not bind it to a tool call, a child run, scope, repair counts, or approval. Those gates are prose in the execute Playbook. This is the accepted risk in ADR 0005.

### Legacy logs

A log written before P4 by the `execute_checkpoint` runtime is valid JSON in another shape. `spec_log` reports it as `legacy (pre-P4): <last event>` in status and refuses every write. There is no import. Use a new slug.

## `/to-spec`

- `/to-spec [slug] [instructions]` sends a packet to the `to-spec` skill. Slugs are 1–48 lowercase letters, digits, or hyphens; `status` is reserved. A slug whose log has an `accepted` event, or whose log cannot be read, is refused. An existing unaccepted Spec is named so the skill asks before overwriting.
- `/to-spec status [slug]` prints `renderSpecStatus` as a `spec-status` message with no model turn. Without a slug it lists every Spec with its phase and `checked/total`.

## Files

- `spec.ts`: pure lint, log schema, read/append, state, Snapshot refs, and status rendering.
- `index.ts`: tool and command registration; `runSpecLog` holds the action logic for tests.
