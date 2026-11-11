---
summary: "Rules agents keep breaking, each paired with what enforces it: a tool refusal, a test, a lint, or prose only."
read_when:
  - "Running the correct Playbook or /correct."
  - "Adding, weakening, or deleting a contract test, loader test, or tool refusal."
  - "A user corrects the same agent mistake a second time."
---

# Enforced rules

One row per rule. **Enforced by** names the file that fails when the rule breaks, or says `prose only`. A `prose only` rule that the user corrects again has repeated: fix it at a higher level per the `correct` Playbook (`skills/supapi-mode/playbooks/correct.md`). Delete a row once its mistake cannot happen.

`extensions/skills/enforced-rules-contract.test.ts` checks that every enforcing file named here exists.

| Rule | Enforced by | Level |
| --- | --- | --- |
| Prompt template frontmatter parses, so Pi does not skip a prompt silently | `extensions/skills/prompt-templates-load.test.ts` | loader test |
| Spec log writes need an accepted Spec | `extensions/spec-log/index.ts` (`block requires an accepted Spec`), `extensions/spec-log/index.test.ts` | tool refusal |
| A pre-P4 Spec log cannot be resumed or written | `extensions/spec-log/spec.ts` (`LegacySpecLogError`), `extensions/spec-log/index.test.ts` | tool refusal |
| Parents read a child's report from the tool result, not `structuredContent` | `extensions/subagent/index.test.ts`, `extensions/skills/execute-contract.test.ts`, `extensions/skills/review-contract.test.ts` | behavior and contract test |
| A capped report is omitted, never sent as cut JSON | `extensions/subagent/index.test.ts` | behavior test |
| Command aliases open the listed skill location instead of searching | `extensions/skills/review-contract.test.ts` | contract test |
| Every Principle a Playbook cites exists, and each pstack Principle carries its MIT credit | `extensions/skills/principles-contract.test.ts` | contract test |
| Every Playbook in the triage kind table has a file, and every Playbook file except `triage` has a row | `extensions/skills/supapi-mode-contract.test.ts` | contract test |
| Review adds no specialist the path table does not match | `extensions/skills/review-contract.test.ts` (wording); `evals/paired-path/` `no-extra-specialist` (behavior, live runs only) | contract test and eval |
| Delete with `trash`, never `rm` | `AGENTS.global.md` | prose only |
| Edit files with the `edit` tool, not Python or ad-hoc scripts | `AGENTS.global.md`; `extensions/skills/global-scope-contract.test.ts` checks the line is present, not obeyed | prose only |
| A triaged turn writes its `Tier:` line before the first edit, write, or executor call; at T2, no work outside `.pi/specs/` before a successful `spec_log` `accept` | `extensions/tier-guard.ts`, `extensions/tier-guard.test.ts` | tool refusal |
| Remove a git worktree with `trash` then `git worktree prune`, never `git worktree remove` | `extensions/worktree-guard.ts`, `extensions/worktree-guard.test.ts` | tool refusal |
| An `ask` option must not point at numbered items the user has not seen | `extensions/ask/item-references.ts` (`ask refused: options refer to numbered items`), `extensions/ask/item-references.test.ts` | tool refusal |
| An `ask` call's own reply must show visible text (or option previews) | `extensions/ask/visible-context.ts` (`ask refused: this reply has no visible text`), `extensions/ask/visible-context.test.ts` | tool refusal |
