---
name: teach
description: "Explain code, a subsystem, or a change so the user understands what it is, how it works, and why it is built that way, at their pace. Gathers facts first through the investigation Playbook's how-it-works step and the why skill. Use for /teach, 'teach me this', or 'help me really understand X'. Use /wait-what to re-explain your last message and /show-me for a visual alone."
---

# Teach

Explain what a thing is, how it works, and why it is built that way, in one plain account at the user's pace. The goal is understanding. Make no edits.

Teach sits on top of two fact-gathering steps. Do not redo their work:

- **How it works:** step 2 of the `investigation` Playbook (`skills/supapi-mode/playbooks/investigation.md`), sized as it says: the main session for a narrow question, `explorer` children for a subsystem.
- **Why it is built that way:** the `why` skill. Keep it narrow by default: the target's git history and the in-repo record only. Widen it only when the reasons are the point.

Run both for a subsystem; one may be enough for a small change. Reword their findings freely for teaching, with one exception: keep the `why` skill's evidence tier on each reason. A hedge is a finding, not style.

## Steps

1. **Pick what they should walk away with.** Choose two or three points from why they ask (about to change it, reviewing it, debugging it, new to it) and what they already know. Read both from the conversation; do not quiz them. Skip what they plainly know.
2. **Gather the facts** through the two steps above. Verify every cited location you use, as the Playbook says.
3. **Start with a plain definition.** Name the thing and say what it is in general terms, with its common name if it has one. Then tie it to this repository ("here, `spec_log` uses this to …") and build out: how it works, then the reasons, then the edge cases. For each part, say what problem it solves and how it actually works. A list of functions and constants is reference, not teaching.
4. **Give the smallest complete answer first,** one or two sentences, then stop. Add layers when they ask. Never a wall of text.
5. **Keep it a conversation.** Offer to go deeper or move on, and follow their lead. No quizzes, no "say it back", no labels such as "the key insight" or "this is the tricky part". Just say it. In a one-shot run with no live user, deliver the account cleanly and put the offer to go deeper at the end.
6. **Show, do not only tell.** Open the code or the diff when that lands it fastest. For a visual, apply the `showing-me` skill to choose the view. For anything with three or more moving parts, draw a short series instead of one full diagram: each diagram redraws the last and adds one part, so the reader sees the system assemble. A single simple point needs no figure.

## Voice

- Plain spoken English, as to a colleague. Tight, not terse.
- Use the project's terms from `CONTEXT.md` when it exists. Give each concept one name and keep it.
- State the concrete mechanism, not a metaphor or a preview of what is coming.
- Short sentences, one or two commas each. Split piled-up clauses.
- The words in these steps are directions to you. Do not print them as headers or stock phrases.

**Principles:** `guard-the-context-window`, `prove-it-works`, `minimize-reader-load`.

**Reply:** the explanation itself, never a report about what you did. Lead with the main point, then what it is, how it works, and why, then the threads worth chasing with `/why` or a follow-up question.

## Attribution

Adapted from Lauren Tan's MIT-licensed [pstack `teach` skill](https://github.com/cursor/plugins/tree/main/pstack). The `how` skill is replaced with the investigation Playbook's how-it-works step, `unslop` with the Voice rules above, and image generation with `showing-me`. Rewritten for Pi.
