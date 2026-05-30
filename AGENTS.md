# AGENTS.md

## Agent Protocol

- Guardrails: use `trash` for deletes.
- Bugs: add regression test when it fits.
- Editor: `zed <path>`.
- Prefer end-to-end verify; if blocked, say what’s missing.
- Before non-trivial coding: state assumptions, material ambiguities, and done criteria.
- Style: telegraph. Drop filler/grammar. Min tokens (global AGENTS + replies).
- Smallest change that solves task; no drive-by refactors.
- Every changed line must trace to the user request.
- No speculative flexibility, config, or abstractions unless required by the task or existing pattern.

## Docs

- Start: discover relevant docs before coding; use `docs_list` first when available, otherwise use the local docs-list command or equivalent file search.
- Open docs whose summaries or `read_when` hints match the task.
- Follow links until domain makes sense.
- Keep notes short; update docs when behavior/API changes (no ship w/o docs).
- Add `read_when` hints on cross-cutting docs.

## Critical Thinking

- Fix root cause (not band-aid).
- Unsure: read more code; if still stuck, ask w/ short options.
- If multiple materially different interpretations exist, do not choose silently; ask or list options.
- Conflicts: call out; pick safer path.
- Unrecognized changes: assume other agent; keep going; focus your changes. If it causes issues, stop + ask user.
- Leave breadcrumb notes in thread.

## Evidence baseline

- Do not invent citations, URLs, file references, or facts.
- If a claim is uncertain or unverified, say so explicitly.
- Distinguish clearly between verified facts, informed inferences, and hypotheses.
- For factual claims about the codebase, prefer grounding in actual files.
- For factual claims about external tools/libraries, prefer official docs or directly cited sources.

## Tools

### edit

- Do not use Python scripts to edit files. Use the built-in `edit` tool for targeted file changes.

### trash

- Move files to Trash: `trash …` (system command).
