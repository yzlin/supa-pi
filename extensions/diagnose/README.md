# Diagnose extension

Registers `/diagnose` for disciplined debugging in pi.

- `/diagnose <request>` injects the diagnose workflow for the supplied bug or performance regression.
- `/diagnose` diagnoses the current session. The agent first inspects recent context and identifies the active failure or ambiguity; if none exists, it asks one clarifying question.

Credit: the workflow in `prompt.md` is adapted from Matt Pocock's `diagnose` skill, licensed MIT, upstream source: https://github.com/mattpocock/skills/tree/main/skills/engineering/diagnose
