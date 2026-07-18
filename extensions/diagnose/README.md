# Diagnose extension

Registers `/diagnose` for disciplined debugging in pi.

- `/diagnose <request>` sends a concise diagnose skill invocation packet for the supplied bug or performance regression.
- `/diagnose` sends a concise diagnose skill invocation packet for `current session`.

The heavy Diagnose protocol is explicit-only: use it after `/diagnose` or an explicit request for the named Diagnose skill, never for an ordinary bug report, debugging request, or fix request. The invocation authorizes reversible, behavior-neutral temporary probes within its requested diagnosis scope without a second consent question; risky, destructive, external, behavior-changing, inaccessible-state, or materially out-of-scope actions still require separate approval.

The canonical workflow lives in `../../skills/diagnose/SKILL.md`. It is evidence-first: diagnosis does not authorize a fix, and a Proven diagnosis must pass the skill's explicit single-select approval gate before any fix edit.

## Attribution

The canonical skill is adapted from:

- Matt Pocock's `diagnose` skill, MIT: https://github.com/mattpocock/skills/tree/main/skills/engineering/diagnose
- LegendApp's `diagnose` skill, MIT: https://github.com/LegendApp/legend-skills/tree/main/diagnose (source reviewed at commit `5a4be517989496d0bc59520a93976360dd1bff51`)
