# Diagnose extension

Registers `/diagnose` for disciplined debugging in pi.

- `/diagnose <request>` sends a concise diagnose skill invocation packet for the supplied bug or performance regression.
- `/diagnose` sends a concise diagnose skill invocation packet for `current session`.

The heavy Diagnose protocol is explicit-only: use it after `/diagnose` or an explicit request for the named Diagnose skill, never for an ordinary bug report, debugging request, or fix request. The invocation authorizes reversible, behavior-neutral temporary probes within its requested diagnosis scope without a second consent question; risky, destructive, external, behavior-changing, inaccessible-state, or materially out-of-scope actions still require separate approval.

The canonical workflow lives in `../../skills/diagnose/SKILL.md`. It is evidence-first: causal reasoning requires one already-run, red-capable feedback-loop command; the human-in-the-loop fallback collects a redacted observation across agent/user turns, derives one concrete path from a validated run ID in a private handoff directory, passes that path literally to Pi `write`, invokes the noninteractive script with the run ID, and removes the handoff after consumption; diagnosis does not authorize a fix; and a Proven diagnosis must pass the skill's explicit single-select approval gate before any fix edit.

## Attribution

The canonical skill is adapted from:

- Matt Pocock's earlier `diagnose` skill, MIT, pinned before its rename at commit `694fa30311e02c2639942308513555e61ee84a6f`: https://github.com/mattpocock/skills/blob/694fa30311e02c2639942308513555e61ee84a6f/skills/engineering/diagnose/SKILL.md
- Matt Pocock's current `diagnosing-bugs` successor, MIT, reviewed at commit `84fdeffd12f2ee307994d1eb6feb48173b6e0502`: https://github.com/mattpocock/skills/tree/84fdeffd12f2ee307994d1eb6feb48173b6e0502/skills/engineering/diagnosing-bugs
- LegendApp's `diagnose` skill, MIT: https://github.com/LegendApp/legend-skills/tree/main/diagnose (source reviewed at commit `5a4be517989496d0bc59520a93976360dd1bff51`)
