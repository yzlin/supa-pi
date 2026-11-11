---
name: figure-it-out
description: Triage tier T3. Design an auditable workflow when work runs unattended or across sessions, needs several phases that each land on their own, or no Playbook fits, such as a large migration or an ambitious multi-part change. Use for /skill:figure-it-out, "figure it out", or a T3 dispatch from the supapi-mode triage Playbook.
---

# Figure it out

This is triage tier T3: the work runs unattended or across sessions, needs several phases that each land on their own, or no Playbook fits. Design the workflow. The first deliverable is the workflow itself: phases that scale rigor to the task and leave a trail the user can audit later.

## A. Frame

Do not start the run until you can state:

- done as a falsifiable predicate you can check on the real artifact;
- scope in rough units, plus blockers found while grounding;
- the rigor level. One-way doors and a wide blast radius get more gates and artifacts; reversible low-stakes steps get fewer.

Show the framing and tradeoffs before a long run. Reversible work proceeds; a multi-hour run gets one checkpoint with the user first. Give an unattended `/goal` run a run limit (`--max-runs N`) so a wrong premise stops instead of looping.

## B. Design the workflow

1. Split the work into units that each land and verify on their own. Put the riskiest unknown first, and scaffolding and verification before features.
2. Build the verification harness before the work, with a baseline from the current state, so each check reads as old versus new.
3. Decide what fans out. Parallelize only across disjoint write scopes with the `subagent` tool. Give each parallel writer or throwaway experiment its own worktree, per the `separate-before-serializing-shared-state` Principle. A run that pushes follows the execute Playbook's push scope.
4. Write the phase list down. That list is what the user reviews.
5. When the plan must survive a fresh session, persist it with `/to-spec` and run it with `/execute`.

## C. Run the loop

Treat each unit as an experiment: state the hypothesis, make the smallest change, check it against the predicate, keep it if it advanced, revert it if it did not. Verify each unit before the next.

- Verify by inspecting the artifact, never a self-report. When something passes too easily, suspect the check first.
- Report each verdict as VERIFIED, NOT VERIFIED, or INCONCLUSIVE. Inconclusive is not a pass.

## D. Keep the trail

Record each decision with what, why, evidence pointer, and result, in the working plan or a local `decisions.tsv` outside git unless the user wants it committed.

## E. Verify and hand back

Check the whole against the Phase A predicate on the real product. Turn any correction you made twice into a test, lint, or script.

**Reply:** the workflow you designed, the rigor level and why, the trail location, what is verified against the predicate, and what is still open. Close with a Final report per the `plain-report` skill.

## Attribution

Adapted from Lauren Tan's MIT-licensed [pstack `figure-it-out` skill](https://github.com/cursor/plugins/tree/main/pstack). Rewritten for Pi.
