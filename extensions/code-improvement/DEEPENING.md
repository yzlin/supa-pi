# DEEPENING

Use these rules to find and describe opportunities for deeper Modules.

## PRINCIPLES

- **Deletion test**: imagine deleting the Module. If complexity vanishes, it was pass-through. If complexity reappears across callers, it was earning its keep.
- **The Interface is the test surface**: callers and tests should cross the same Seam.
- **One Adapter = hypothetical Seam. Two Adapters = real Seam**: do not introduce a Seam unless something actually varies across it.
- Domain language from `CONTEXT.md` should name good Seams when available.
- ADRs record decisions that should not be re-litigated unless current friction is real enough to reopen them.

## CANDIDATE SELECTION REPORT

Return 3-5 numbered candidates. Each candidate must include these fields:

- **Candidate** — short name using repo/domain vocabulary when known.
- **Files** — files or Modules involved.
- **Module** — the Module that appears shallow, scattered, or missing.
- **Current Interface** — what callers/tests must know today.
- **Implementation friction** — where behavior, rules, ordering, or errors leak.
- **Depth diagnosis** — why the Module is shallow or where a deeper Module could exist.
- **Seam / Adapter notes** — current or proposed Seam, current Adapters, and whether variation is real.
- **Deletion test** — what happens if the suspected Module is deleted.
- **Leverage** — what callers would get from a deeper Interface.
- **Locality** — what maintainers/tests would get from concentrated behavior.
- **Test impact** — how testing would improve through the Interface.
- **CONTEXT / ADR notes** — domain terms used, missing docs, or ADR conflicts worth reopening.
- **Risk** — why this might not be worth doing.
- **Implementation plan sketch** — high-level read-only plan, no code changes.

Do not propose final Interfaces in the candidate report. Ask which candidate should be turned into an implementation plan.

## IMPLEMENTATION PLAN STOPPING POINT

After the candidate is selected and any needed Interface design is complete, stop at an implementation plan. The final answer must not implement. The implementation plan should include:

- Chosen Module and Interface direction.
- Files to change.
- Step-by-step changes.
- Validation plan.
- Risks and ADR/CONTEXT updates to consider.
