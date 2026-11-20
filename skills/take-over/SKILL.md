---
name: take-over
description: Learn a process the user does by hand so the agent can take it over. Restates the user's goal and process, asks one question at a time about how they decide, where they get information, how they check the work, and when to ask for help, then walks through 2–3 examples before anything is automated. Use for /take-over, "take this over from me", or "this is how I usually do X". Use /grill-me to stress-test a plan instead.
---

# Take over

The user does this job by hand today and wants you to do it. Most of what makes them good at it is not written down. Your job in this skill is to find that and write it down. Do not do the job yet.

Keep this skill read-only until the user locks the process: no edits, no messages, no tracker or chat writes, no runs of the process itself. Reading code, docs, and data to learn the process is allowed.

## A. Restate

In simple English, restate:

- the goal: what the process is for and who uses the result;
- the inputs and where they come from;
- the steps, in order;
- the output;
- how the user knows a run is done and good.

Mark each part you guessed as a guess. Then confirm with one `ask`: correct, or correct me. On a correction, restate again. Do not go on until the user confirms the restatement.

## B. Find the gaps

Ask one question per round, because each answer shapes the next question. Follow the `grilling` skill for `ask`, option previews, the recommended option, and the Decision brief. Cover these areas in order, and go deeper where the answers are vague:

1. **Decisions:** how the user decides at each step that has a choice. Ask for the rule, the threshold, and the exceptions they make.
2. **Information:** where the user gets each input, which source wins when two disagree, and what they ignore.
3. **Checks:** how the user checks the work before it counts as done, and what a bad result looks like.
4. **Escalation:** when you must stop and ask the user, and what you may decide alone.

Find facts in the environment before you ask: the code, docs, past runs, and the tools that hold the inputs. Ask the user only what the environment cannot answer.

## C. Walk through examples

Pick 2–3 real cases, including one that is not typical. Find them in the environment, or ask the user for them. For each case, do a dry run in the reply, without side effects:

- the input you would read;
- each step, and the decision rule you applied;
- the check you would run, and its result;
- where you would stop and ask.

Ask the user to correct each case. Each correction becomes a decision rule, a source, a check, or an escalation rule. Change the process to match it, then do the next case.

## D. Lock

Write a **Process brief** in the reply, in Plain report style per the `plain-report` skill:

- goal and done predicate;
- steps;
- decision rules;
- sources and which one wins;
- checks;
- escalation rules;
- the worked examples and what each one changed.

Then ask one final `ask` with exactly two options, `Lock process, stop here` and `Keep refining`. Only `Lock process, stop here` ends the interview.

After the lock, offer the next step and act only on the user's pick:

- draft a skill or a Playbook from the brief;
- `/to-spec` to persist it as a Spec for `/execute`;
- a `/goal` run with a run limit;
- stop.

**Principles:** `never-block-on-the-human`, `encode-lessons-in-structure`, `prove-it-works`.

**Reply:** the current phase's output only: the restatement, one question, one example, or the Process brief.

## Attribution

Adapted from prompts by Lauren Tan (poteto), author of the MIT-licensed [pstack](https://github.com/cursor/plugins/tree/main/pstack). The user passed the prompts on; they have no public source we can link. Rewritten for Pi.
