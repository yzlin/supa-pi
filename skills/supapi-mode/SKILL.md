---
name: supapi-mode
description: "Hub router: read before the first tool call on any bug fix, feature, refactor, prototype, diagnosis, PR, or how/why question about code, however small the change looks. Matches the task to one Playbook under playbooks/, then follows its steps. Skip only a one-line answer from one file or a typo fix."
---

# SupaPi mode

Match the task to one Playbook, read that Playbook file, and follow its steps. Playbooks live at `playbooks/<name>.md` next to this file; resolve them against this skill's directory.

## Route

1. Restate the user's goal in one sentence.
2. Pick the first Playbook below whose trigger fits. Read its file before acting.
3. Copy the Playbook's numbered steps into your working plan. Keep a skipped step in the plan with `skip: <reason>`.
4. If no Playbook fits, or the work is large, cross-cutting, or will run unattended, load the `figure-it-out` skill instead.
5. If the task turns out to be trivial, say so and work directly.

| Playbook | Trigger |
| --- | --- |
| `investigation` | Read-only question: how X works, why Y exists, should we do X or Y. |
| `diagnose` | `/diagnose`, or a request to prove the cause of a symptom before any fix. |
| `bug-fix` | A reported defect to reproduce, root-cause, fix, and verify. |
| `feature` | New or changed behavior. |
| `refactoring` | Behavior-preserving change to structure: rename, extract, inline, dedupe, move, simplify. |
| `prototype` | A throwaway sketch to settle a design or empirical fork by observation. |
| `execute` | `/execute`, or running a Spec or an accepted multi-step plan to verified Done Criteria. |
| `correct` | `/correct`, or making a repeated agent mistake impossible with a structural check. |
| `fix-review-findings` | `/review-fix`, or fixing findings from a review report. A request for a review alone loads the `review-orchestration` skill instead. |
| `opening-a-pr` | `/pr`, or writing, opening, or submitting a pull request. Other Playbooks end here when the user asks for a PR. |

## Shared rules

- Each Playbook names the skills it calls. Load a skill only when a step needs it.
- Delegate with the `subagent` tool only for parallel disjoint or context-heavy work. You own every subagent result: verify it yourself before you report it.
- A step is done only when its evidence exists: a command run, a file read, an output observed. A child report is a claim, not evidence.
- Principles live in `~/.pi/agent/rules/principles/<name>.md` (repo: `rules/principles/`). Each Playbook lists the ones it applies; read a Principle when its "Apply when" fits, and name the one that changed a decision.
- Close multi-step work with a Final report per the `plain-report` skill.

## Attribution

The hub, Playbook, and fallback shape is adapted from Lauren Tan's MIT-licensed [pstack `poteto-mode`](https://github.com/cursor/plugins/tree/main/pstack). Playbook text is rewritten for Pi.
