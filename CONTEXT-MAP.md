# CONTEXT-MAP

## Read first

- `CONTEXT.md` — read before changing product language, extension registration, setup behavior, licensing notes, or durable context docs.
- `AGENTS.md` — read before coding in this repo; contains project workflow, docs, verification, and deletion guardrails.
- `extensions/AGENTS.md` — read before changing any Extension under `extensions/`; contains extension-boundary and validation rules.

## Architecture decisions

- `docs/adr/` — proposed, accepted, superseded, deprecated, or rejected tradeoff decisions.

## Context notes

- `docs/context/` — longer durable notes that should not live in chat only.
- `docs/context/extension-registration.md` — read before changing `package.json -> pi.extensions`, documenting active Extensions, or reasoning about disabled Extension code.
- `docs/context/questionnaire.md` — read before changing the active Questionnaire Extension, its schema/result shape, keyboard behavior, validation, or rpiv-divergence documentation.
- `docs/context/code-improvement.md` — read before changing `/simplify`, `/improve-codebase-architecture`, or code-improvement prompt files.
- `extensions/review/README.md` — read before changing `/review`, `/review-summary`, `/review-fix`, reviewer-agent orchestration, or review prompt contracts.

## Major extension docs

- `extensions/caveman/README.md` — read before changing `/caveman`, caveman-mode persistence, or generic extension status behavior.
- `extensions/code-improvement/SIMPLIFY.md` and `docs/context/code-improvement.md` — read before changing `/simplify` behavior, scoped simplify boundaries, or code-simplifier delegation.
- `extensions/code-improvement/IMPROVE-CODEBASE-ARCHITECTURE.md` — read before changing `/improve-codebase-architecture` architecture review behavior.
- `extensions/context-docs/README.md` — read before changing `/context-setup`, `/context-note`, `/adr`, `/context-review`, or `/context-grill` behavior.
- `extensions/goal/README.md` — read before changing `/goal`, goal task mode, goal checkpoint behavior, goal status rendering, or Goal Extension registration.
- `extensions/init-deep/README.md` — read before changing `/init-deep` AGENTS.md generation behavior.
- `extensions/lsp/README.md` — read before changing the LSP tool or `/lsp` command behavior.
- `extensions/pieditor/README.md` — read before changing editor UX features such as file picking, shell completions, raw paste, command remapping, or status bar behavior.
- `docs/context/questionnaire.md` — read before changing `extensions/questionnaire/*` behavior.
- `extensions/tool-display/README.md` — read before changing tool renderer ownership, config, skill-file `read` override behavior, tool-display metadata, or RTK full-skill-read compaction exemptions.
- `extensions/rtk/README.md` — read before changing output compaction, `bash` ownership, or `/rtk` behavior.
- `extensions/smart-docs/README.md` — read before changing smart documentation generation workflows.

## Maintenance rules

- List only real durable context boundaries here; avoid cataloging every file.
- Use plain-language `read before...` guidance for cross-cutting docs.
- Keep entries stable, source-grounded, and small.
- If an Extension is present but not registered, document it as disabled rather than active.
