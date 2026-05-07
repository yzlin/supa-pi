# Diagnose

A disciplined diagnosis loop for hard bugs and performance regressions. Reproduce → minimise → hypothesise → instrument → fix → regression-test.

Adapted for pi from Matt Pocock's diagnose skill.

## Operating rules

- Build a fast, deterministic, agent-runnable pass/fail signal before fixing.
- Confirm the loop reproduces the user's exact failure, not a nearby failure.
- Generate 3–5 ranked, falsifiable hypotheses before testing.
- Briefly state hypotheses to the user. Continue if the user is absent unless the next step is risky or irreversible.
- Instrument one variable at a time.
- Use tagged debug logs only, e.g. `[DEBUG-a4f2]`, and remove them before done.
- Make the smallest fix that addresses the root cause.
- Add a regression test when a correct seam exists.
- Do not do broad refactors while diagnosing.
- Do not suppress type errors to make progress.

When exploring the codebase, use project docs, domain glossary, CONTEXT files, and ADRs when present.

## Phase 1 — Build a feedback loop

This is the skill. Everything else is mechanical. If you have a fast, deterministic, agent-runnable pass/fail signal for the bug, you will find the cause. Bisection, hypothesis-testing, and instrumentation all consume that signal.

Spend disproportionate effort here. Be aggressive and creative.

Try feedback loops in roughly this order:

1. Failing test at whatever seam reaches the bug: unit, integration, e2e.
2. Curl / HTTP script against a running dev server.
3. CLI invocation with fixture input, diffing stdout against a known-good snapshot.
4. Headless browser script: Playwright / Puppeteer, asserts on DOM/console/network.
5. Replay a captured trace: network request, payload, event log.
6. Throwaway harness around a minimal subset of the system.
7. Property / fuzz loop for sometimes-wrong output.
8. Bisection harness for commit, dataset, or version regressions.
9. Differential loop against old-version vs new-version or two configs.
10. Human-in-the-loop bash script as last resort, with structured captured output.

Treat the loop as a product:

- Make it faster.
- Make the signal sharper.
- Make it deterministic.

For non-deterministic bugs, raise the reproduction rate. Loop 100×, parallelise, add stress, narrow timing windows, inject sleeps. A 50% flake is debuggable; 1% is not.

If you genuinely cannot build a loop, stop and say so. List what you tried. Ask for environment access, captured artifacts, or permission to add temporary instrumentation. Do not proceed to vibes.

## Phase 2 — Reproduce

Run the loop. Watch the bug appear.

Confirm:

- The loop produces the failure mode the user described.
- The failure is reproducible across multiple runs, or high-rate enough for flaky bugs.
- The exact symptom is captured: error message, wrong output, slow timing.

Do not proceed until you reproduce the bug, unless you explicitly state why reproduction is blocked.

## Phase 3 — Hypothesise

Generate 3–5 ranked hypotheses before testing any.

Each hypothesis must be falsifiable:

> If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse.

Discard or sharpen vibe hypotheses.

Briefly state the ranked list to the user. Continue with your ranking if the user is absent and the next step is safe.

## Phase 4 — Instrument

Each probe must map to a specific prediction from Phase 3. Change one variable at a time.

Tool preference:

1. Debugger / REPL inspection if available.
2. Targeted logs at boundaries that distinguish hypotheses.
3. Never “log everything and grep”.

Tag every debug log with a unique prefix, e.g. `[DEBUG-a4f2]`.

For performance regressions, establish a baseline measurement first: timing harness, profiler, query plan, or equivalent. Measure first, fix second.

## Phase 5 — Fix + regression test

Write the regression test before the fix when a correct seam exists.

A correct seam exercises the real bug pattern as it occurs at the call site. If only a shallow seam exists, say that and avoid false confidence.

If a correct seam exists:

1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail.
3. Apply the smallest root-cause fix.
4. Watch the test pass.
5. Re-run the Phase 1 loop against the original scenario.

## Phase 6 — Cleanup + post-mortem

Before declaring done:

- Original repro no longer reproduces.
- Regression test passes, or absence of seam is documented.
- All `[DEBUG-...]` instrumentation removed.
- Throwaway prototypes deleted or clearly marked.
- The correct hypothesis/root cause is stated in the final summary.

Then ask what would have prevented the bug. If architecture blocked a correct test seam or caused hidden coupling, recommend `/improve-codebase-architecture` with specifics after the fix.
