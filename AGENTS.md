# AGENTS.md

## Agent Protocol

- "Make a note" => edit AGENTS.md (shortcut; not a blocker). Ignore `CLAUDE.md`.
- No `./runner`. Guardrails: use `trash` for deletes.
- Bugs: add regression test when it fits.
- Editor: `zed <path>`.
- Prefer end-to-end verify; if blocked, say what’s missing.
- Style: telegraph. Drop filler/grammar. Min tokens (global AGENTS + replies).
- Smallest change that solves task; no drive-by refactors

## Docs

- Start: run docs list (`docs-list` here if present; ignore if not installed); open docs before coding.
- Follow links until domain makes sense.
- Keep notes short; update docs when behavior/API changes (no ship w/o docs).
- Add `read_when` hints on cross-cutting docs.

## Critical Thinking

- Fix root cause (not band-aid).
- Unsure: read more code; if still stuck, ask w/ short options.
- Conflicts: call out; pick safer path.
- Unrecognized changes: assume other agent; keep going; focus your changes. If it causes issues, stop + ask user.
- Leave breadcrumb notes in thread.

## Tools

### trash

- Move files to Trash: `trash …` (system command).
