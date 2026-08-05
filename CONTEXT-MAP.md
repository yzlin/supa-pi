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
- `docs/context/gpt-5.6-harness-optimization.md` — read before changing default models, thinking levels, agent model routing, prompt size, prompt caching, tool exposure, structured model output, or model evals.
- `extensions/review/README.md` — read before changing `/review`, `/review-summary`, `/review-fix`, reviewer-agent orchestration, or review prompt contracts.

## Major extension docs

- `extensions/caveman/README.md` — read before changing `/caveman`, caveman-mode persistence, or generic extension status behavior.
- `extensions/fast/README.md` and `docs/context/extension-registration.md` — read before changing `/fast`, `--fast`, Fast Mode persistence, provider payload patching, model `fastMode: true` metadata, or Fast Mode status rendering.
- `extensions/code-improvement/SIMPLIFY.md` and `docs/context/code-improvement.md` — read before changing `/simplify` behavior, scoped simplify boundaries, or code-simplifier delegation.
- `extensions/diagnose/README.md` and `skills/diagnose/SKILL.md` — read before changing `/diagnose`, its evidence-first diagnosis contract, temporary probe consent, or the explicit post-Proven fix gate.
- `extensions/code-improvement/IMPROVE-CODEBASE-ARCHITECTURE.md` — read before changing `/improve-codebase-architecture` architecture review behavior.
- `skills/context-docs/SKILL.md` and `extensions/context-docs/README.md` — read before changing `/context-setup`, `/context-note`, `/adr`, or `/context-review`; the skill canonically owns shared and command-specific behavior while the extension supplies the runtime envelope.
- `skills/grilling/SKILL.md` — read before changing natural-language adversarial interviews or the shared grilling contract.
- `skills/grill-me/SKILL.md` and `prompts/grill-me.md` — read before changing explicit `/grill-me <plan>` behavior. The command skill is a thin wrapper that permits only lock-gated, qualifying changes to `CONTEXT.md`, `CONTEXT-MAP.md`, and ADRs.
- `extensions/execute/README.md` — read before changing `/execute`, Execution Brief reuse/synthesis, or execute orchestration behavior.
- `extensions/goal/README.md` — read before changing `/goal`, goal task mode, goal checkpoint behavior, goal status rendering, or Goal Extension registration.
- `extensions/init-deep/README.md` — read before changing `/init-deep` AGENTS.md generation behavior.
- `extensions/lsp/README.md` — read before changing the LSP tool or `/lsp` command behavior.
- `@yzlin/pieditor` — external npm-installed Pi package for editor UX behavior; `setup.sh` installs it via `npm:@yzlin/pieditor`.
- `docs/context/questionnaire.md` — read before changing `extensions/questionnaire/*` behavior.
- `extensions/tool-display/README.md` — read before changing tool renderer ownership, config, skill-file `read` override behavior, tool-display metadata, or RTK full-skill-read compaction exemptions.
- `extensions/rtk/README.md` — read before changing output compaction, `bash` ownership, or `/rtk` behavior.
- `extensions/smart-docs/README.md` — read before changing smart documentation generation workflows.

## Maintenance rules

- List only real durable context boundaries here; avoid cataloging every file.
- Use plain-language `read before...` guidance for cross-cutting docs.
- Keep entries stable, source-grounded, and small.
- If an Extension is present but not registered, document it as disabled rather than active.
