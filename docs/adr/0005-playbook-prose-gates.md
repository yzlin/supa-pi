---
summary: "Move /execute, /review, and /goal gates from TypeScript enforcement into prose; /review keeps no code guarantees, and execute keeps only an append-only Spec log recorder."
read_when:
  - "Converting /execute, /review, or /goal into Playbooks, or deleting their ledger, verifier, or checkpoint enforcement code."
  - "Interpreting why ADR 0003 and ADR 0004 are superseded."
---

# ADR 0005: Playbook prose gates

- Status: Accepted (2026-11-04, after the paired eval)
- Date: 2026-11-04
- Deciders: Ethan
- Supersedes: ADR 0003, ADR 0004
- Superseded by: none

## Context

The approved Playbook architecture (`docs/context/subsystems.md` "Playbook architecture") routes work through one Hub skill, `skills/supapi-mode/`, and its Playbooks. `/execute`, `/review`, and `/goal` enforce their contracts in TypeScript tools. Examples are `execute_checkpoint` verify and repair rules (ADR 0003), the `review_run`/`review_finalize` binding and the verifier account (ADR 0004), and goal checkpoints. These tools keep a second routing model next to the Playbooks.

pstack (Lauren Tan, MIT) gets similar guarantees with prose only. For example, `poteto-mode` says "You own every subagent's work" and requires fresh verification. Nothing enforces these rules in code.

## Decision

- Convert `/execute` and `/goal` into Playbooks, and `/review-fix` into the fix-review-findings Playbook. `review-orchestration` becomes a report-only technique skill, following pstack's `interrogate`. Gates become prose steps. Examples are independent main verification, the two-repair limit, and the rule that every review candidate gets an accepted or rejected verdict.
- `/review` keeps no code guarantees. `review_run`/`review_finalize` run binding, freshness, once-only publication, and verifier candidate accounting are deleted.
- Specs stay immutable and content-hashed. Each Done Criterion names its evidence, and a `check-spec` script lints Spec shape. The execute Playbook records each verified Done Criterion with its evidence pointer through a small `spec_log` tool, the only Spec log writer. Snapshot refs and goal checkpoints stay, so cross-session resume stays reliable. This follows pstack's checkbox plan with `check-plan.mjs`, with the checked state kept in the log instead of the plan file.
- Do this in phase P3 (review) and phase P4 (execute and goal), after the P1 and P2 Playbooks prove the shape.
- Delete enforcement code only after a paired eval passes. The eval runs 3–5 fixed execute and review tasks on the old and new paths. The new path must match the old path on verification, repair-limit behavior, and review findings.

## Implementation note

2026-11-04: by user decision, P3 deleted the `/review` enforcement code and P4 deleted `extensions/execute/` before the paired eval. The old path for that eval is a worktree at commit `a503abd`. P4 dropped the Spec review classifier and moved Spec lint into the `spec_log` tool (`extensions/spec-log/`); `/goal` budget checks stay in code.

## Eval result

2026-11-04: `evals/paired-path/` ran 4 cases (2 execute, 2 review) × 3 repetitions on old `a503abd` and new `e3943fa`. Both paths passed 48/48 checks: hidden probe tests, scope, recorded completion, main verification after the last edit, all three seeded review defects, and no false blocker on a clean change. New execute cost the same or less; new review took about 2× the time and tokens. 2026-11-05 follow-up: main no longer reads child `result.json` files (the tool result now carries the validated report), aliases open the listed skill location directly, and specialists come only from the path table. New-path main-session tokens fell 30–46%. See `evals/paired-path/README.md`.

2026-11-05 gate cases (3 repetitions each): a scope trap and a destructive step held on both paths (15/15 checks each). A false child `done` (scripted faux executor, 3 repetitions) was caught on both paths, with at most 3 executor calls and a recorded block (12/12 checks each). All gate classes in the original decision now have a paired case.

## Consequences

- The runtime no longer stops the model when it skips verification, exceeds repairs, or publishes unverified review output. The paired eval is the only control. Drift after the eval goes undetected unless later evals or `/retro` find it.
- A stale or replayed review report is no longer detected, because review run binding is deleted.
- About 45 extension files, their offline tests, and README contracts shrink or go away. Restoring them after deletion means reviving code, tests, and docs.
- The persisted execution ledger in old sessions stops being read. Spec files and Spec logs stay valid.
- There is one routing model, Hub → Playbook, for all multi-step work.

## Alternatives considered

- Move the procedure text but keep enforced gates in TypeScript. This is safer and keeps ADRs 0003 and 0004 valid, but two routing models stay. It was rejected in favor of a uniform model.
- Convert only prompt-only commands (`/diagnose`, `/simplify`, `/pr`, `/grill-me`, `/wayfinder`). This has lower risk, but keeps two kinds of entry. It was rejected.
- Drop Spec and `/goal` state entirely and use pause and pickup Playbooks. This has the smallest surface, but loses reliable resume. It was rejected.
- Keep review run binding and once-only publication as recording. This protects against stale reports, but keeps review machinery. It was rejected in favor of a report-only review skill.
- Tick Spec checkboxes in the Spec file, as pstack does. This shows progress directly, but breaks the content hash and the revision flow. It was rejected.
