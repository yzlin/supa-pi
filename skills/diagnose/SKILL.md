---
name: diagnose
description: Use only after `/diagnose` or an explicit request to use the named Diagnose skill; ordinary bug reports, debugging requests, and fix requests must not activate it.
---

# Diagnose

## Activation (explicit only)

Use this heavy protocol only after a `/diagnose` invocation or an explicit request to use the named Diagnose skill. Do not activate it for an ordinary bug report, debugging request, or fix request.

Diagnose first. An explicit Diagnose invocation asks for diagnosis, not a fix. The words “fix it,” the invocation itself, or prior permission to investigate never preapprove a fix.

Adapted for Pi from Matt Pocock's `diagnose` skill (MIT), https://github.com/mattpocock/skills/tree/main/skills/engineering/diagnose, and LegendApp's `diagnose` skill (MIT), source reviewed at commit `5a4be517989496d0bc59520a93976360dd1bff51`, https://github.com/LegendApp/legend-skills/tree/main/diagnose.

## Non-negotiable contract

- Evidence precedes remedies. Do not edit production behavior while diagnosing.
- Establish the **exact anchor**: the precise observed symptom, expected result, trigger/input, environment/version, and code or system boundary under investigation. Do not substitute a nearby failure.
- If the failure is already observable, attempt a clean reproduction first, before adding instrumentation or changing conditions.
- Build the smallest complete set of ranked, falsifiable causal candidates. “Complete” means it covers the plausible causes supported by current evidence; do not force an arbitrary count or include vague possibilities.
- Minimise progressively only when each reduction improves evidence by making the signal faster, sharper, more repeatable, or more discriminating. Preserve the original scenario as a revalidation control.
- Choose the smallest set of probes that discriminates among the live candidates. Every probe must state the prediction that would support or falsify candidates.
- Keep hypotheses, proof decisions, and the final diagnosis in the main thread. Subagents may only collect bounded, mechanical evidence with explicit inputs and outputs; they may not choose hypotheses, declare proof, propose fixes, or edit behavior.
- Do not perform broad refactors, hide type errors, or make speculative fixes.
- Stop when no discriminating probe exists. Also stop after three materially different fix attempts fail; report what evidence or access is missing.

## 1. Anchor and clean reproduction

Read the repository's governing docs, domain vocabulary, and ADRs. Record the exact anchor and define an agent-runnable observation that distinguishes pass from fail.

When the symptom is already observable, reproduce it cleanly first with existing tests, commands, logs, traces, UI state, or metrics. Prefer the narrowest real seam that still exhibits the exact symptom. Capture the command/input, environment, observed output, and run identifier or timestamp. Never expose secrets or raw sensitive data.

For a deterministic issue, repeat enough to reject a one-off. For a flaky issue, run a fixed-count baseline under fixed conditions and record successes/failures as counts. Preserve the same workload, environment, sampling window, and stopping rule for later intervention and control runs; do not silently stop when a favorable result appears.

If clean reproduction is impossible, say exactly why. Existing redacted artifacts can support candidates, but absence of a reproducible causal signal limits the result to `Incomplete`.

## 2. Candidate model and minimisation

Create the smallest complete falsifiable candidate set. For each candidate record:

- causal claim and rank;
- evidence for and against;
- a prediction unique enough to distinguish it;
- the least invasive observation or intervention that tests it.

Use progressive minimisation only when it improves the evidence. At each step retain the last known reproducer and compare the reduced case with it. A smaller example that changes the symptom, drops the relevant boundary, or merely becomes convenient is not progress.

Do not delegate reasoning. A subagent request must be bounded mechanical collection such as “run these commands and return redacted outputs keyed by run ID.” Reconcile that evidence and update candidates in the main thread.

## 3. Probe plan, authorization, and privacy

Prefer existing observability and behavior-neutral inspection. Select the smallest complete probe set whose outcomes discriminate among the candidates; avoid one-variable-at-a-time ritual when correlated boundary observations are needed.

Correlate evidence structurally across boundaries with a generated run/trace ID and stable event fields, for example:

```text
{ probe: "diag-a4f2", runId: "r17", boundary: "queue->worker", event: "received", candidate: "C2", value: "<allowlisted>" }
```

Do not “log everything and grep.” Define a field allowlist before collection, redact at capture, and retain only what is necessary. Never capture or print secrets, tokens, credentials, private keys, session material, or raw sensitive request/response bodies. Prefer counts, hashes, shapes, classifications, and synthetic fixtures. Preserve only redacted artifacts.

The explicit Diagnose invocation itself authorizes reversible, behavior-neutral temporary probes within the requested diagnosis scope; do not ask a second consent question for those probes. Before adding one, disclose:

- exact files/components and environment;
- the behavior-neutral probe and predicted outcomes;
- allowlisted fields and redaction;
- duration, risk, and cleanup plan.

Separate user approval remains mandatory before risky or destructive actions, external mutations or side effects, access to otherwise inaccessible credentials or state, deployed or product-behavior changes, or instrumentation materially outside the invoked scope. Probe authorization is limited to the invoked scope and is not fix approval. Tag temporary probes uniquely (for example `[DIAG-a4f2]`) and maintain an inventory.

Route platform-specific collection to an existing specialized skill when available (for example browser, database, deployment, observability, or performance tooling). Give it a bounded evidence request and use its result here; do not duplicate platform operating instructions in this skill.

If required approval is declined, or diagnosis is abandoned, remove agent-added probes and temporary state while preserving only useful redacted artifacts.

See [references/instrumentation.md](references/instrumentation.md) for operational probe patterns.

## 4. Proof standard

Classify diagnosis only as:

- **Proven** — a discriminating causal intervention changes the anchored signal as predicted, an appropriate control does not, and competing live candidates are contradicted or no longer explain all evidence.
- **Incomplete** — anything less, including correlation alone, reproduction without causal discrimination, blocked access/consent, or conflicting evidence.

Do not publish confidence percentages. `Incomplete` never offers, recommends, or applies a fix. It may state the next discriminating evidence needed. Before every terminal `Diagnosis: Incomplete` / `Fix: Not attempted` report, remove all agent-added probes and temporary state unless the user explicitly approves retaining specific items; preserve only useful redacted artifacts. If no such probe exists, stop.

### Flaky failures

For flaky behavior, proof requires predeclared fixed-count reproduction-rate runs for baseline, intervention, reversal/control, under equivalent conditions and stopping rules. Record raw pass/fail counts and relevant run conditions. The intervention must shift the failure signal in the predicted direction, and reversal or a matched control must restore or retain the expected contrast. Do not infer causality from a lucky clean run.

### Performance regressions

Before intervention, establish a matched baseline and report workload, warm-up, sample count, environment, distribution/variance (not only an average), and resource conditions. Use a profile or equivalent attribution evidence to identify where cost accumulates. Compare the proposed causal intervention against both baseline and an unchanged or reversal control under equivalent conditions. A faster single run or an unprofiled timing difference is not proof.

## 5. Required post-Proven fix gate

Only after `Diagnosis: Proven`, prepare a scoped proposal that names:

1. the root-cause remedy;
2. exact files/components expected to change;
3. the honest regression-test seam, or why none exists;
4. targeted verification, including the original causal signal and relevant control.

Then use `questionnaire` for one mandatory single-select question with exactly these two supplied options (do not use `multiSelect` and do not add another option):

- `Approve scoped fix`
- `Stop and clean probes`

Do not edit the fix before the user selects `Approve scoped fix`. Invocation wording, “fix it,” general autonomy, and approval of probes do not satisfy this gate. If the questionnaire cannot be used, do not infer approval or edit the fix; report the blocked gate and print both exact choices `Approve scoped fix` and `Stop and clean probes` verbatim.

Selection of `Stop and clean probes`, refusal, cancellation, or abandonment means remove agent-added probes and temporary state, preserve only redacted artifacts, and stop. A material deviation from the approved remedy, files, regression seam, or verification plan requires a new proposal and the same gate again.

## 6. Approved fix, targeted revalidation, and cleanup

After approval:

1. Keep the diagnostic probes in place through verification.
2. At an honest seam, first add or run a regression test that exercises the real causal pattern. If no honest seam exists, document the absence; do not add a shallow test and imply coverage.
3. Apply the smallest approved root-cause fix.
4. Run targeted causal revalidation: the regression test when available, the original anchored signal, the discriminating probe, and the appropriate reversal/matched control. For flaky or performance issues, repeat the proof controls above.
5. Only after verification, remove all agent-added probes and temporary state and retain redacted evidence needed for the report.

If verification fails, set `Fix: Failed`, reverse only agent-owned fix edits (do not discard user work or unrelated changes), keep approved probes, incorporate the new evidence, and rerank the candidates in the main thread. A materially different remedy must pass the post-Proven gate again. Stop after three materially different failed fix attempts, clean the probes and temporary state, and preserve only redacted artifacts.

## 7. Report

Always report diagnosis and fix independently, on separate lines, using exactly these state families:

```text
Diagnosis: Proven | Incomplete
Fix: Verified | Failed | Not attempted
```

State the exact anchor, decisive evidence and controls, redactions/artifacts retained, probe cleanup status, and—when Proven—the causal explanation. Never issue a terminal `Incomplete` / `Fix: Not attempted` report while agent-added probes or temporary state remain unless the user explicitly approved retaining the reported items. `Fix: Verified` requires targeted causal revalidation, not merely a passing broad suite. Use `Fix: Not attempted` when the gate was not approved or diagnosis is incomplete.
