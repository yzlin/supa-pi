---
title: Paired-path eval
read_when:
  - running or changing the old-vs-new /execute and /review comparison for ADR 0005
  - deciding whether Playbook prose gates replaced deleted enforcement code safely
status: active
---

# Paired-path eval

Compares the old coded path (commit `a503abd`, before P1) and the new Playbook path end to end. Each run starts real `pi --mode rpc` in a seeded git repo with a fresh isolated `HOME`. Its `~/.pi/agent` points `agents/`, `prompts/`, `rules/`, `themes/`, `AGENTS.md`, and `extensions/supa-pi` at one worktree. Children inherit `HOME`, so they use the same arm.

Shared, read-only from the live setup: `auth.json`, `models.json`, `subagent.json`, `review.json`, `git/`, and the `pi-claude-code` provider package. The `claude` binary runs through a wrapper that restores the real `HOME`, because its login lives there.

Dialogs (`confirm`, `select`, `input`) are answered from each case's `dialogs` rules. The `ask` tool needs TUI `custom()`; in RPC it returns cancelled. Both arms see the same limit.

## Cases

`cases.ts`: two execute cases (a two-criterion Spec, an inline plan) and two review cases (three seeded defects, a clean change). Scoring is offline, in `score()`:

- execute: `bun test`, hidden probe tests written only at scoring time, changed paths within `src/`, `tests/`, `.pi/`, a Spec log ending in `done`, and a main `bash` test command after the last edit or child call;
- review: regex over the main report text for each seeded defect, unchanged tree, and no critical/high/blocking claim on the clean change.

The scorers are coarse. Read the reports for close calls.

## Run

```sh
git worktree add --detach /tmp/supa-pi-paired/old a503abd
git worktree add --detach /tmp/supa-pi-paired/new HEAD
ln -s "$PWD/node_modules" /tmp/supa-pi-paired/old/node_modules
ln -s "$PWD/node_modules" /tmp/supa-pi-paired/new/node_modules
bun evals/paired-path/run.ts --repetitions 3            # plan only, no model calls
bun evals/paired-path/run.ts --live --old /tmp/supa-pi-paired/old --new /tmp/supa-pi-paired/new --repetitions 3
```

Output: `/tmp/supa-pi-paired/runs/<stamp>/<case>-<arm>-<n>/` with `ws/`, `home/` (children's sessions under `home/.pi/agent/subagents/`), `sessions/`, `rpc.jsonl`, and `result.json`; plus `results.json`.

Cost: the main session and every child use the configured model (`claude-code/claude-opus-5-5` by default; agents keep their own pins). Usage is summed from session files. The provider may not report a dollar cost.

Offline tests: `bun test evals/paired-path`.
