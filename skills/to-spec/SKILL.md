---
name: to-spec
description: Explicit /to-spec wrapper. Use when the user invokes /to-spec or when an /execute draft-then-execute packet requests it; persists the current conversation's locked plan as a Spec for /execute.
---

# `/to-spec`

## Input and Synthesis

The execute Extension's `/to-spec` packet supplies an optional slug and may state that an unaccepted Spec already exists for that slug. The Extension itself refuses slugs whose Spec log has an `accepted` event or is corrupt; still check collisions before writing.

Synthesize from the current conversation and codebase understanding. Do not interview. Preserve locked decisions, scope, constraints, and deferred items. Use `CONTEXT.md` glossary vocabulary and respect ADRs in the touched area. Read targeted code and existing tests to resolve facts rather than asking the user. Do not invent unresolved decisions; if the plan is not locked or a non-testing blocker remains, stop and report the gap instead of writing a guessed Spec.

Ask exactly one testing-seam question with the `ask` tool only when Verification would otherwise be a guess; prefer existing, highest seams. Wait for the answer before writing. This is not another plan interview. Overwrite confirmation below is a separate file-safety gate.

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
- DC-2: <necessary technical criterion> (technical)

## Verification
<Actual commands or checks, expected evidence, and who verifies it.>

## Testing Seams
<Only when useful: boundaries exercised and why these seams suffice.>

## Out of Scope
<Explicit exclusions and deferred work.>
```

`Testing Seams` is optional; omit its heading when not needed. `Execution Scope`, `Plan`, `Done Criteria`, `Verification`, and `Out of Scope` are required for `/execute` brief detection. Keep `User Stories` even for internal-only work.

Plan uses literal workspace-relative paths where known, needed for `/execute` write scopes. Do not follow upstream's no-file-path rule. Make the Brief self-contained for a fresh session: include the locked decisions and evidence needed to execute without the old conversation. Verification uses existing commands and the highest practical seams, not speculative tests.

## User Stories and Coverage

User Stories are required when user- or caller-visible behavior changes. Number them `US-1` through `US-n`, using `As a <actor>, I want <capability>, so that <benefit>`. Keep one story per distinct actor+outcome, no padding.

Otherwise the section is exactly one line: `N/A — internal: <reason>`. Replace `<reason>` with the concrete internal-only reason; do not add stories or extra prose to that section.

Before writing, check coverage in both directions:

- each story maps to at least one Done Criterion;
- each Done Criterion ends with `(US-n)` citations or `(technical)`. Use actual story IDs, for example `(US-1)` or `(US-1) (US-2)`; reserve `(technical)` for necessary technical work without a story.

Each Done Criterion row is `- DC-n: <criterion> (US-n)` or `- DC-n: <criterion> (technical)`. Number labels `DC-1` through `DC-n`, each unique. Start every top-level line in `## Done Criteria` with its label; indent continuation lines. `/execute` rejects a Spec with an unlabeled row, a repeated label, or no rows, and each assignment declares the `DC-n` IDs it proves.

Fix gaps before writing. Internal-only work uses `(technical)` for every Done Criterion.

## Slug and Collision Rules

Use the given slug or derive a short kebab-case slug from the goal. It must match `^[a-z0-9][a-z0-9-]*$` and be at most 48 characters. `status` and `classifier` are reserved subcommand words, never slugs. Reject an invalid supplied slug without silently changing it.

- If `.pi/specs/<slug>.log.jsonl` has an `accepted` event, or cannot be read and parsed, refuse and suggest a new slug. Never overwrite an accepted or done Spec, even if the packet calls it unaccepted.
- A log that is empty or has only `reviewed` events means the Spec was never accepted. Treat it like a Spec without a log.
- If only `.pi/specs/<slug>.md` exists, ask with `ask` before overwriting. Without confirmation, do not overwrite. Show the replacement content or diff in an assistant message first; keep the `ask` prompt to one short line naming the path.
- Otherwise write the new Spec.

Recheck collisions before writing, including after confirmation. If existence cannot be determined safely, stop and report the blocker. A Spec is immutable after write except for a confirmed replacement of a never-accepted Spec under the collision rule above.

## Allowed Writes

Write only `.pi/specs/<slug>.md`; create the `.pi/specs/` directory if needed. This storage is local and git-ignored; do not publish, commit, or change ignore configuration as part of this workflow.

Never write or edit the Spec log or Snapshot refs. The execute Extension alone writes the append-only Spec log and manages Snapshot refs. Never edit a Spec after it is accepted; changes go through `/execute`'s explicit revision. Do not write context docs, issue-tracker records, or implementation files.

## Finish

Print the path and the next step: run `/execute @.pi/specs/<slug>.md` (a fresh session is fine). `/to-spec status <slug>` shows progress. `/to-spec classifier [enable|disable]` shows or changes consent for the Spec review classifier that `/execute` uses before accept; standalone `/to-spec` never reviews. Suggest the commands; do not start execution automatically.

Exception: when invoked as the first step of an `/execute` draft-then-execute packet, do not stop after writing; print the path, then continue directly into the `execute` skill on that Spec, passing `specPath` on `accept`. Standalone `/to-spec` never starts execution.

Advise running `/to-spec` before compaction when context is near its limit.

## Attribution

Ideas adapted from [Matt Pocock's MIT-licensed to-spec skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md): no-interview synthesis, testing seams, glossary/ADR respect, and out of scope. This local skill paraphrases those ideas rather than copying upstream text.

Rejected parts: issue-tracker publishing and triage labels, extensive story lists, and the no-file-path rule.
