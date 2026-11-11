---
summary: "Spec-backed /execute ends with an independent dc-verifier on another model family, Specs with user-visible behavior carry lint-enforced Live Lanes (at least one lane; a baseline lane when existing behavior changes), and spec_log verify pass (not the last check) writes done while no checked criterion is stale."
read_when:
  - "Changing the execute Playbook's Finish step, the dc-verifier agent, or its report schema."
  - "Changing spec_log check, verify, done, Snapshot refs, the stale rule, or Live Lanes lint."
  - "Interpreting why ADR 0003's 'fresh child checks: rejected' and ADR 0005's 'gates are prose' no longer hold in full."
---

# ADR 0006: Finish verifier and Live Lanes

- Status: Accepted (2026-11-11)
- Date: 2026-11-11
- Deciders: Ethan
- Supersedes: ADR 0003 in part (the rejected alternative "Main edits, a fresh child checks"); ADR 0005 in part (one gate moves back into code)
- Superseded by: none

## Context

pstack (`cursor/plugins` @ `246bc50`, `poteto-mode` `multi-phase-plan`, `autopilot-full`, `shipping`, and the `swarm` skill) verifies work in three ways that SupaPi's execute Playbook did not:

1. A verifier that did not write the code, on another model family, gives the verdict. Green checks and the author's own report are inputs, not a verdict.
2. Every PR has live lanes that drive the real surface, each with a saved artifact and a pass predicate, plus a regression lane against trunk.
3. A verdict covers one patch (`git patch-id`). A later change needs a new verdict.

SupaPi's main session ran each Done Criterion's evidence and recorded `spec_log` `check`. The last `check` wrote `done`. A check stayed "checked" after later edits.

ADR 0003 rejected "main edits, a fresh child checks". Its planted-defect eval (`checker-*`, 18 runs) found no extra catches from a fresh child checker, at about 61% more cost. That ADR also says the eval does not show that self-checking catches defects no criterion states. ADR 0005 moved execute gates into prose.

## Decision

By user decision (2026-11-11, two Spec review rounds, `.pi/specs/pstack-verify.md`):

- **Finish verifier, always.** After the last `check`, the review gate, the repository check, and a fresh re-check of every criterion, main calls one blocking `subagent` with agent `dc-verifier` (`agents/dc-verifier.md`, `openai-codex/gpt-6-sol`; every other agent is `claude-code/*`). It is read-only on the workspace. It re-runs every criterion's evidence and every lane, runs baseline lanes in a detached worktree of the base snapshot, audits the diff for defects that no criterion states, and reports through `skills/supapi-mode/schemas/dc-verify.schema.json`. At most two verifier rounds follow the first; then the run blocks.
- **Live Lanes.** `spec_log` `lint` requires `## Live Lanes` unless `User Stories` is the internal-only line: at least one lane, each with `Drive:`, `Artifact:`, and `Pass when:`. A `(baseline)` lane with a `Baseline:` line is optional; the `to-spec` rules ask for one when the change alters existing behavior. This replaces pstack's ten lanes per PR; SupaPi Specs are usually one repository change.
- **Amended 2026-11-11 (lighter lanes).** The first version required a minimum of three lanes, one of them a baseline lane. By user decision, this was loosened to at least one lane with an optional baseline (`.pi/specs/lighter-lanes.md`). Lane counts sized for pstack's multi-PR work forced invented lanes on small Specs. A new feature has no base behavior to compare, so its baseline lane was busy-work. A strict count also made the internal-only escape attractive.
- **Stale checks, whole tree.** `accept` records the base snapshot as `refs/pi-specs/<slug>/0`. `status` marks a checked criterion `[~]` when any file outside `.pi/specs/` changed since its snapshot. This replaces pstack's `git patch-id` rule, because SupaPi runs on uncommitted trees. Per-criterion path scoping was rejected as more authoring work for little gain.
- **One code gate (amends ADR 0005).** `check` no longer writes `done`. A new `spec_log` `verify` action records `verified {verdict, findings, evidence, head, snapshot}`. Only `verify pass` writes `done`, and only when every criterion is checked and none is stale.

## Consequences

- Cost: every Spec-backed `/execute` spends one more child run on `openai-codex/gpt-6-sol`, plus up to two more on `issues`. Specs with user-visible behavior need at least one lane.
- The extra catch rate is unmeasured. The only evidence is the DC-7 smoke in `.pi/specs/pstack-verify.md`: one correct fixture (expect `pass`) and one fixture with a defect no criterion states (expect `issues`). A paired eval against main-only checking is open work. ADR 0003's measured result (no extra catches on criterion-stated defects) still stands for the defects it tested.
- `spec_log` still does not check that a `dc-verifier` ran or that the `verdict` passed is the one it returned. That stays a prose gate, as in ADR 0005.
- Any edit after a check makes every earlier check stale. Finish therefore re-runs every criterion's evidence once more.
- `evals/paired-path` new-arm execute cases now reach `done` only after a live verifier run. Their fixture Specs carry Live Lanes; the old arm ignores the section. No live rerun was done with this change.
- Old Spec logs still parse: the new `accepted` fields are optional.

## Alternatives considered

- Risk-triggered verifier (8+ criteria or a one-way door). Cheaper, but the defects the verifier exists for are not tied to Spec size. Rejected by user decision.
- Verifier on every criterion. Closest to pstack, highest cost, and contradicts ADR 0003's measured result without new data. Rejected.
- Eval first, then decide. Rejected by user decision in favor of shipping with a two-fixture smoke and naming the eval as open.
- Keep `done` on the last `check` and make the verifier prose only. No log record of the verdict, and nothing stops a skipped verifier. Rejected.
- Refuse `done` while stale without a `verify` event. Leaves the verifier unrecorded. Rejected for the `verify` event.
