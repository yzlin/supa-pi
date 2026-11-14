---
name: to-spec
description: Explicit /to-spec wrapper. Use when the user invokes /to-spec or when the execute Playbook drafts a Spec; persists the current conversation's locked plan as a Spec for /execute.
---

# `/to-spec`

## Input and Synthesis

The `spec-log` Extension's `/to-spec` packet supplies an optional slug and may state that an unaccepted Spec already exists for that slug. The Extension itself refuses slugs whose Spec log has an `accepted` event or is corrupt; still check collisions before writing.

Synthesize from the current conversation and codebase understanding. Do not interview. Preserve locked decisions, scope, constraints, and deferred items. Use `CONTEXT.md` glossary vocabulary and respect ADRs in the touched area. Read targeted code and existing tests to resolve facts rather than asking the user. Do not invent unresolved decisions; if the plan is not locked or a non-testing blocker remains, stop and report the gap instead of writing a guessed Spec.

Ask exactly one testing-seam question with the `ask` tool only when Verification would otherwise be a guess; prefer existing, highest seams. Write a Decision brief per the `grilling` skill before it, naming the seams each option exercises and what it leaves unproven. Wait for the answer before writing. This is not another plan interview. Overwrite confirmation below is a separate file-safety gate.

## Execution Brief Format

Write plain Markdown, no frontmatter; status lives in the Spec log. Start with `# Execution Brief` and use these level-two headings in this order:

```markdown
# Execution Brief

## Execution Scope
<Goal, locked constraints, and touched boundaries.>

## User Stories
<Numbered stories, or the internal-only N/A line below.>

## Plan
<Ordered work, dependencies, and literal workspace-relative paths.>

## Done Criteria
- DC-1: <observable acceptance criterion> (US-1)
  Evidence: <exact command or check that proves it>
- DC-2: <necessary technical criterion> (technical)
  Evidence: <exact command or check that proves it>

## Live Lanes
- LANE-1: <scenario a user would run> (DC-1)
  Drive: <exact command or driver>
  Artifact: $TMPDIR/pi-verify/<slug>/<file>
  Pass when: <observable predicate>
- LANE-2: <scenario whose existing behavior changes; omit this lane for a new feature> (DC-2) (baseline)
  Drive: <exact command or driver>
  Artifact: $TMPDIR/pi-verify/<slug>/<file>
  Pass when: <observable predicate>
  Baseline: <same scenario at the base snapshot, and the expected base result>

## Verification
<Actual commands or checks, expected evidence, and who verifies it.>

## Testing Seams
<Only when useful: boundaries exercised and why these seams suffice.>

## Out of Scope
<Explicit exclusions and deferred work.>
```

`Testing Seams` is optional; omit its heading when not needed. `Execution Scope`, `Plan`, `Done Criteria`, `Verification`, and `Out of Scope` are required; `spec_log` `lint` rejects a Spec without them. `Live Lanes` is required unless `User Stories` is the `N/A — internal: <reason>` line. Keep `User Stories` even for internal-only work.

Plan uses literal workspace-relative paths where known, needed for `/execute` write scopes. Do not follow upstream's no-file-path rule. Make the Brief self-contained for a fresh session: include the locked decisions and evidence needed to execute without the old conversation. Verification uses existing commands and the highest practical seams, not speculative tests.

## User Stories and Coverage

User Stories are required when user- or caller-visible behavior changes. Number them `US-1` through `US-n`, using `As a <actor>, I want <capability>, so that <benefit>`. Keep one story per distinct actor+outcome, no padding.

Otherwise the section is exactly one line: `N/A — internal: <reason>`. Replace `<reason>` with the concrete internal-only reason; do not add stories or extra prose to that section.

Before writing, check coverage in both directions:

- each story maps to at least one Done Criterion;
- each Done Criterion ends with `(US-n)` citations or `(technical)`. Use actual story IDs, for example `(US-1)` or `(US-1) (US-2)`; reserve `(technical)` for necessary technical work without a story.

Each Done Criterion row is `- DC-n: <criterion> (US-n)` or `- DC-n: <criterion> (technical)`. Follow each row with an indented `Evidence: <exact command or check>` line naming how the execute Playbook proves it; `spec_log` `check` later records what was actually observed. Number labels `DC-1` through `DC-n`, each unique. Start every top-level line in `## Done Criteria` with its label; indent continuation lines. `spec_log` `lint` rejects a Spec with an unlabeled row, a repeated label, a row without an `Evidence:` line, or no rows.

Fix gaps before writing. Internal-only work uses `(technical)` for every Done Criterion.

## Live Lanes

Live Lanes are the scenarios the `dc-verifier` runs on the real surface at Finish, as pstack's live lanes do. Write them when user- or caller-visible behavior changes; `spec_log` `lint` requires the section unless `User Stories` is the internal-only line, and checks it whenever it is present.

- Each row is `- LANE-n: <scenario> (DC-n)`, with a unique label and at least one `(DC-n)` citation of an existing Done Criterion.
- Each lane has indented `Drive:` (the exact command or driver: shell command, tmux keys, `web-browser` skill, `glimpse`), `Artifact:` (where the verifier saves the output, under the artifact directory `$TMPDIR/pi-verify/<slug>/`, outside the workspace so it never makes a check stale), and `Pass when:` (an observable predicate) lines.
- Write at least one lane, usually one per user-visible outcome.
- When the change alters existing behavior, add a `(baseline)` lane: end its row with `(baseline)` and give it a `Baseline:` line with the same scenario at the base snapshot recorded at accept and the expected base result. Skip the baseline lane for a new feature. A `Baseline:` line needs the `(baseline)` tag.
- Pick scenarios a user or caller would run, not unit tests; Done Criteria already name those.

## Slug and Collision Rules

Use the given slug or derive a short kebab-case slug from the goal. It must match `^[a-z0-9][a-z0-9-]*$` and be at most 48 characters. `status` is a reserved subcommand word, never a slug. Reject an invalid supplied slug without silently changing it.

- If `.pi/specs/<slug>.log.jsonl` has an `accepted` event, or cannot be read and parsed, refuse and suggest a new slug. Never overwrite an accepted or done Spec, even if the packet calls it unaccepted.
- A log that is empty or has only `reviewed` events means the Spec was never accepted. Treat it like a Spec without a log.
- If only `.pi/specs/<slug>.md` exists, ask with `ask` before overwriting. Without confirmation, do not overwrite. Show the replacement content or diff in an assistant message first; keep the `ask` prompt to one short line naming the path.
- Otherwise write the new Spec.

Recheck collisions before writing, including after confirmation. If existence cannot be determined safely, stop and report the blocker. A Spec is immutable after write except for a confirmed replacement of a never-accepted Spec under the collision rule above.

## Allowed Writes

Write only `.pi/specs/<slug>.md`; create the `.pi/specs/` directory if needed. This storage is local and git-ignored; do not publish, commit, or change ignore configuration as part of this workflow.

Never write or edit the Spec log or Snapshot refs. The `spec_log` tool alone writes the append-only Spec log and manages Snapshot refs. `/to-spec` never edits a Spec after it is accepted; changes go through `/execute`'s Spec revision, where `spec_log` `accept` shows the diff and the user approves it before `revise: true`. Do not write context docs, issue-tracker records, or implementation files.

## Finish

Before printing, call `spec_log` with `action: "lint"` and fix every problem it reports. Print the path and the next step: run `/execute @.pi/specs/<slug>.md` (a fresh session is fine). `/to-spec status <slug>` shows progress as checkboxes. Suggest the commands; do not start execution automatically.

Exception: when the execute Playbook drafts the Spec, do not stop after writing; print the path, then continue with that Playbook on the Spec. Standalone `/to-spec` never starts execution.

Advise running `/to-spec` before compaction when context is near its limit.

## Attribution

Ideas adapted from [Matt Pocock's MIT-licensed to-spec skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md): no-interview synthesis, testing seams, glossary/ADR respect, and out of scope. This local skill paraphrases those ideas rather than copying upstream text.

Rejected parts: issue-tracker publishing and triage labels, extensive story lists, and the no-file-path rule.
