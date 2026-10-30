---
summary: "Let /execute run sequential assignments in the main session, gated by scope and a fresh check instead of a child report."
read_when:
  - "Changing /execute start or verify rules, the executor field, main-attempt guards, or when /execute delegates to children."
---

# ADR 0003: Main-executed `/execute` attempts

- Status: Accepted
- Date: 2026-10-30
- Deciders: Ethan
- Supersedes: none
- Superseded by: none

## Context

Before this change, `/execute` gave every assignment to a fresh `executor` child. The ledger refused `verify` unless a bound child reported `done` (`extensions/execute/ledger.ts`). For sequential work this child did not save context, did not run in parallel and had no special tools. It also did not supply the fresh-context check, because main, which has the full conversation, did the checking.

Two measurements support a change:

- Folding `/simplify` and `/review-fix` into main gave equal scores at about 40% lower cost (`docs/context/harness-contract-audit.md`, `extensions/review/README.md`).
- A planted-defect checker eval (`evals/prompt-optimization/corpus.json`, cases `checker-*`, 18 runs on 2026-10-30) found that main checking its own seeded change caught both auth defects and passed the clean control in 9 of 9 runs. A fresh read-only child checker gave the same verdicts at $0.164 vs $0.102 per run.

## Decision

- `start` takes optional `executor: "main"`. The assignment stores `executor: "main"`. No `dispatchPrefix` is issued.
- A main attempt runs alone. It cannot start while another assignment runs, and nothing starts while it runs. It cannot start for a `cwd` outside the workspace.
- While it runs, the runtime blocks `edit`/`write` calls whose targets are outside the declared scope or cannot be determined, and blocks execution `subagent` dispatch.
- A passing `verify` of a main attempt needs a successful `bash` call after main's last `edit` or `write` in that attempt. This freshness is held in memory only.
- A completed main attempt has no child report. Ledger validation accepts `executor: "main"` in place of the done claim, and rejects a main attempt that holds a bound call, run ID or report.
- The `execute` skill makes main the default for sequential work. Children remain for parallel disjoint work, context-heavy tasks, and outside-workspace `cwd`.

## Consequences

"Child claims never complete assignments" still holds for children. For main attempts the rule becomes "main evidence after a fresh check completes". This is weaker: the runtime proves that a check ran after the last edit, not that the check was relevant, and main judges its own work.

The scope guard is lexical. It does not resolve symlinks and does not check writes made through `bash`.

`executor` is optional in the persisted v1 ledger, so existing session entries still validate. No migration is needed. A ledger written by this version can hold `executor: "main"`, which an older runtime rejects as an unknown field. That only matters when a session is opened with an older build.

The checker eval used two small defects that break written criteria. It does not show that self-checking catches defects that no criterion states.

## Alternatives considered

- Keep children for all work: rejected, because the child had no justifying condition for sequential work and measured folds were cheaper at equal quality.
- Route small plans out of the ledger (skill-only): rejected, because it gives up resume, the repair budget, the audit trail and Done Criterion tracking on that path.
- Main edits, a fresh child checks: rejected for now, because the checker eval showed no extra catches at about 61% more cost.
