---
name: supapi-mode
description: "Hub router: read before the first tool call on any bug fix, feature, refactor, prototype, diagnosis, PR, or how/why question about code, however small the change looks. Check again on every later request in a session and on each step of a multi-step request: in \"simplify, commit and open pr\", the PR step still needs its Playbook, and a skill loaded for another step does not replace it. Starts with the triage Playbook, which picks the kind (and, for build work, a size tier) and dispatches to one Playbook under playbooks/, then follows its steps. Skip only a one-line answer from one file or a typo fix."
---

# SupaPi mode

Start every request that loads this skill with the triage Playbook. It picks the kind and, for build work, the size tier, then names the Playbook to follow. Playbooks live at `playbooks/<name>.md` next to this file; resolve them against this skill's directory.

## Route

1. Read `playbooks/triage.md` next to this file and follow it. Your first message after sizing starts with its `Tier:` line, before any tool call that writes.
2. Read the Playbook it dispatches to before acting. Copy that Playbook's numbered steps into your working plan. Keep a skipped step in the plan with `skip: <reason>`.

## Shared rules

- Each Playbook names the skills it calls. Load a skill only when a step needs it.
- Delegate with the `subagent` tool only for parallel disjoint or context-heavy work. You own every subagent result: verify it yourself before you report it.
- A step is done only when its evidence exists: a command run, a file read, an output observed. A child report is a claim, not evidence.
- Principles live in `~/.pi/agent/rules/principles/<name>.md` (repo: `rules/principles/`). Each Playbook lists the ones it applies; read a Principle when its "Apply when" fits, and name the one that changed a decision.
- Close multi-step work with a Final report per the `plain-report` skill.
- **Unit loop:** split the work into units that each end in a verifiable state, in dependency order, riskiest unknown first. Run units in the main session by default; delegate only parallel units with disjoint write scopes, or work that would flood the context. A child that builds, installs, or formats works in its own worktree, per `separate-before-serializing-shared-state`. After each unit, run its check yourself: a child's report is a claim. Allow at most two repair attempts per unit after the first try; then stop and report the unit as blocked (at T2, with `spec_log` `block`). Before you verify a change that renames or moves strings, formats, or files other code may read, run the `blast-radius` skill on the change.
- **Review gate:** for every non-trivial diff, run the `simplify` skill on the changed files from `git status`, then the `review-orchestration` skill on the diff, then triage its findings through steps 1–7 of the `fix-review-findings` Playbook in gate mode: fix what you are sure about and list the rest for the user to review. Rerun the checks after the fixes. Skip the gate only for a trivial diff, such as a typo or one local line, and say why you skipped it. Playbooks that call the gate run it before their PR step.

## Attribution

The hub, Playbook, and fallback shape is adapted from Lauren Tan's MIT-licensed [pstack `poteto-mode`](https://github.com/cursor/plugins/tree/main/pstack). Playbook text is rewritten for Pi.
