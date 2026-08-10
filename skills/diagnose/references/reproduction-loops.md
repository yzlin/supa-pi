# Reproduction feedback loops

Operational detail for Phase 1 of `../SKILL.md`. This reference does not weaken the canonical privacy, proof, control, or fix-gate requirements.

## Construction ladder

Try the narrowest real seam that can assert the exact anchored symptom, roughly in this order:

1. **Failing test** — unit, integration, or end-to-end at the first honest seam.
2. **HTTP script** — a redacted `curl` or equivalent against a controlled server.
3. **CLI fixture** — invoke one command and compare stdout, stderr, exit status, or a snapshot.
4. **Browser script** — drive the UI and assert the relevant DOM, console, or network signal.
5. **Captured-trace replay** — replay a redacted request, payload shape, event sequence, or trace through the real path.
6. **Throwaway harness** — boot the smallest real subsystem and trigger the path with controlled dependencies.
7. **Property or fuzz loop** — run seeded inputs until the exact failure predicate appears.
8. **Differential or bisection loop** — compare known-good and bad versions/configurations, or automate `git bisect run`.
9. **Structured human-in-the-loop fallback** — use `scripts/hitl-loop.template.sh` only when the remaining action cannot be automated.

A loop that only checks “did not crash” is not red-capable unless that is the exact anchored symptom.

## Tighten the loop

Once the loop catches the bug, improve it before causal probing:

- **Faster** — cache setup, bypass unrelated initialization, narrow the command.
- **Sharper** — assert the exact wrong value, error, state transition, or timing distribution.
- **More repeatable** — pin time, random seeds, fixtures, filesystem state, dependencies, and network behavior.

Keep the original scenario as a revalidation control while minimising. A reduced case is useful only when it preserves the anchored symptom and relevant boundary.

## Flaky discovery versus proof

During discovery, raise a low reproduction rate with fixed-count repetition, parallel runs, controlled stress, narrowed timing windows, or temporary sleeps. Record every changed condition and verify that the same anchored symptom remains.

**Discovery amplification is not proof.** After the bug is reproducible enough to investigate, return to predeclared fixed-count baseline, intervention, and reversal or matched-control runs under equivalent conditions. Never stop early after a favorable run.

## Human-in-the-loop fallback

Copy `scripts/hitl-loop.template.sh` into a temporary diagnostic location and edit only the bounded instructions. Move the interaction across agent/user turns: ask the user to perform the unavoidable action and return only the requested observation, with authentication remaining entirely user-owned. Validate and redact that reply. Choose a unique Diagnose run ID containing only letters, digits, and hyphens. Resolve the current numeric user ID, create `/tmp/supa-pi-diagnose-<uid>-<run-id>` with mode `700`, and provide its concrete `/tmp/supa-pi-diagnose-<uid>-<run-id>/observation.txt` path literally to Pi's `write` tool. Then invoke the script with the same literal `--run-id` value. Do not pass `$(id -u)`, `${TMPDIR:-/tmp}`, a placeholder, or any other shell expression to `write`. Never accept a caller-selected observation path or interpolate an observation into a Bash command. The script validates the private directory and derived file, then removes them after consuming the observation. Do not run the script while waiting for terminal input; Pi's bash executor has no interactive stdin.

Capture only allowlisted, redacted observations—never credentials, tokens, cookies, authorization headers, or raw sensitive bodies. The resulting command and structured output form the already-run feedback loop.

If even this cannot produce a red-capable loop, stop with `Diagnosis: Incomplete`. Report attempts made and request the missing environment access, redacted artifact, or separately approved instrumentation.

## Attribution

Adapted from Matt Pocock's MIT-licensed `diagnosing-bugs` skill, reviewed at commit `84fdeffd12f2ee307994d1eb6feb48173b6e0502`: https://github.com/mattpocock/skills/tree/84fdeffd12f2ee307994d1eb6feb48173b6e0502/skills/engineering/diagnosing-bugs.
