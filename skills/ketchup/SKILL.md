---
name: ketchup
description: "Catch the user up on what changed in this session since their last message, in plain words, and list every call waiting on them with what they need to decide it from the reply alone. Use for /ketchup, or 'catch me up' after long or unattended work. Use /wait-what to re-explain only your last message."
---

# Ketchup

Catch the user up on what changed since the last message they wrote before `/ketchup`, and help them understand each change. Then lay out every call waiting on them so they can make it from this reply alone. Subagent results, tool output, and notifications are not their messages. Assume they remember their last message and nothing after it.

Keep this turn read-only: do not edit files, start a job or a live run, commit, or post anything.

## Gather

- Collect your own work since that message: edits, commits, runs, and subagent reports. Read the session if you need to; do not rely on memory of a long run.
- Check the current state of what the work touched: `git status`, `git log` since the last user message, open worktrees, running jobs, and any Spec log (`spec_log` `status`). A step you reported as done but cannot see is not done.
- Check each number you will show against its source, and say so when you correct one.
- An **action item** is a call only the user can make: a product choice, an approval, an irreversible or external step (push, publish, delete), a live model run that needs approval, or access you lack. Include any still waiting from before their last message. Work you can still do yourself is not an action item. Never invent a call to fill the reply.
- For each item, collect what it changes for the user, the evidence for your pick, its risk, and your pick. Write "unknown" for a fact the call needs that you do not have.

## Write

Voice: plain words and short sentences, as one person catching up another. Say what changed for the user, not how you did it: "the tests pass", not "371 pass, 0 fail". Leave out hashes, paths, commands, and counts unless the user needs one to act. Use names the user knows, from `CONTEXT.md` when it exists.

1. **Open** with one sentence that names what waits on the user, or says nothing does. If nothing happened and nothing waits, say so and stop.
2. **What happened**, under 100 words: one short bullet per thing the user asked for, saying what came of it and whether it is done, still running, failed, or not checked. Write each line as you would say it aloud. Name any bug found and fixed on the way. Never mark something done that still waits on the user. Then at most three lines that change what they know or must do, and one line for work left that you can do yourself.
3. **Action items**, about 30 words each, riskiest first. Ask the call, give your pick, what it changes, the evidence, and the risk, even when low ("Low risk: local only, nothing pushed"). When items share a call, write the call and pick once, then one bullet per item. For a choice between options, give each option's gain and cost; those are the risk. Say what waiting costs only when it is more than a delay.

Never cut or merge items to stay short; the reply grows with the number of calls. A link can add depth, but the reply alone must be enough to decide.

## Visuals

Draw only when a picture is faster than words: how a change works, a chain of dependent steps, a before and after. Apply the `showing-me` skill to pick the view. Keep it to at most six boxes of at most eight words each. Never draw a status list or the action items, never repeat a fact the text gives, and never invent a number.

**Principles:** `never-block-on-the-human`, `prove-it-works`, `guard-the-context-window`.

## Attribution

Adapted from Lauren Tan's MIT-licensed [pstack `ketchup` skill](https://github.com/cursor/plugins/tree/main/pstack). The `/bro` voice, `/visualize`, and PR and CI checks are replaced with Pi's session, git, Spec log, and `showing-me`; rewritten for Pi.
