# AGENTS.md

## Agent Protocol

- Guardrails: use `trash` for deletes.
- Bugs: add regression test when it fits.
- Editor: `zed <path>`.
- Prove it works: narrowest sufficient real proof → `~/.pi/agent/rules/principles/prove-it-works.md`.
- Before non-trivial coding: state assumptions, material ambiguities, and done criteria.
- Style: telegraph for global AGENTS, chat replies, progress updates. Drop filler/grammar. Min tokens. Final reports after multi-step work follow `plain-report`.
- Smallest complete change; no drive-by refactors → `~/.pi/agent/rules/principles/laziness-protocol.md`.
- No speculative abstraction/config/flexibility → `~/.pi/agent/rules/principles/subtract-before-you-add.md`.
- Principles: one rule per file in `~/.pi/agent/rules/principles/`; name the one that changed a decision.

## Docs

- Discover relevant docs when the task needs unfamiliar project or domain context, or scoped instructions require it. Use `docs_list` when available; otherwise use the local docs-list command or equivalent search.
- Skip discovery for obvious typos, mechanical edits, and already-understood local changes unless scoped instructions require it.
- Read docs whose summaries or `read_when` hints match the task; follow links only to resolve task-relevant gaps.
- Keep notes short; update docs when behavior/API changes (no ship w/o docs).
- Add `read_when` hints on cross-cutting docs.

## Critical Thinking

- Fix root cause, not band-aid → `~/.pi/agent/rules/principles/fix-root-causes.md`.
- Repo-owned contracts: migrate callers, delete old path → `~/.pi/agent/rules/principles/migrate-callers-then-delete-legacy-apis.md`.
- Unsure: read more code; if still stuck, ask w/ short options.
- Never choose silently: state the choice, or ask when it is irreversible or product direction → `~/.pi/agent/rules/principles/never-block-on-the-human.md`.
- Conflicts: call out; pick safer path.
- Unrecognized changes: assume other agent; keep going; focus your changes. If it causes issues, stop + ask user.
- Leave breadcrumb notes in thread.

## Evidence baseline

- Verify code, files, flags, and current behavior before fixing or recommending from memory.
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

### Slack links

- Slack URLs (`*.slack.com/archives/…`): always use the `slack-links` skill (executor MCP). Never web-fetch or browse them.
