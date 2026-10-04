# CONTEXT-MAP

## Read first

- `CONTEXT.md` — read before changing product language, extension registration, setup behavior, licensing notes, or durable context docs.
- `AGENTS.md` — read before coding in this repo; contains project workflow, docs, verification, and deletion guardrails.
- `extensions/AGENTS.md` — read before changing any Extension under `extensions/`; contains extension-boundary and validation rules.
- `skills/domain-modeling/SKILL.md` — read before changing domain terminology, scenario testing, contradiction handling, boundary analysis, ADR candidacy, or domain-modeling composition with other skills.
- `skills/wayfinder/SKILL.md`, its `templates/`, and `prompts/wayfinder.md` — read before Wayfinder planning, record formats, resume/ownership behavior, or `/wayfinder` command changes.

## Architecture decisions

- `docs/adr/` — proposed, accepted, superseded, deprecated, or rejected tradeoff decisions.
- `docs/adr/0002-use-pi-fullscreen.md` — read before changing Pi version support, setup TUI defaults, fullscreen/regular compatibility, or pieditor viewport ownership.

## Context notes

- `docs/context/` — longer durable notes that should not live in chat only.
- `docs/context/extension-registration.md` — read before changing `package.json -> pi.extensions`, documenting active Extensions, or reasoning about disabled Extension code.
- `docs/context/ask.md` — read before changing the active Ask Extension, its public `ask` tool or `/ask-stats` command, schema/result shape, keyboard behavior, validation, or rpiv-divergence documentation.
- `docs/context/code-improvement.md` — read before changing `/simplify`, `/improve-codebase-architecture`, or code-improvement prompt files.
- `docs/context/model-routing.md` — read before checking or documenting current repository model defaults for setup, agents, review, evals, or Fast Mode; live settings and overrides may differ.
- `docs/context/gpt-5.6-harness-optimization.md` — read before interpreting historical GPT-5.6 reasoning, service-tier, prompt, caching, tool-surface, or eval evidence.
- `docs/context/gpt-6-astra-harness-readiness.md` — read before interpreting historical Astra approvals and comparisons, or planning an approval-gated Astra eval or full-stack probe.
- `docs/context/harness-contract-audit.md` — read before changing research-artifact ownership, search-first delegation, or instruction ownership across prompts, agents, skills, and rules; preserves historical audit evidence and deferred live-calibration gates.
- `extensions/review/README.md` — read before changing `/review`, `/review-summary`, `/review-fix`, reviewer-agent orchestration, or review prompt contracts.

## Major extension docs

- `extensions/model-profiles/README.md` — read before changing `/profile`, `model-profiles.json`, Generated agent overrides, or live `~/.pi/agent/agents` file ownership.
- `extensions/skill-router/README.md` — read before changing skill-router registration/order, effective-catalog policy, TypeSafe authentication or paid consent, privacy/limits, lifecycle fallback, or rollout claims.
- `extensions/auto-rename/README.md` — read before changing automatic session naming, `/auto-rename`, its global configuration, title safety/privacy boundaries, or session/tree concurrency protections.
- `extensions/sift/README.md` — read before changing Sift, `sift_files`, `/sift`, TypeSafe authentication/consent, data-transfer limits, or its security boundary.
- `extensions/caveman/README.md` — read before changing `/caveman`, caveman-mode persistence, or generic extension status behavior.
- `extensions/fast/README.md` and `docs/context/extension-registration.md` — read before changing `/fast`, `--fast`, Fast Mode persistence, provider payload patching, model `fastMode: true` metadata, or Fast Mode status rendering.
- `extensions/code-improvement/SIMPLIFY.md` and `docs/context/code-improvement.md` — read before changing `/simplify` behavior, scoped simplify boundaries, or code-simplifier delegation.
- `extensions/diagnose/README.md` and `skills/diagnose/SKILL.md` — read before changing `/diagnose`, its evidence-first diagnosis contract, temporary probe consent, or the explicit post-Proven fix gate.
- `extensions/code-improvement/IMPROVE-CODEBASE-ARCHITECTURE.md` — read before changing `/improve-codebase-architecture` architecture review behavior.
- `skills/context-docs/SKILL.md` and `extensions/context-docs/README.md` — read before changing `/context-setup`, `/context-note`, `/adr`, or `/context-review`; the skill canonically owns shared and command-specific behavior while the extension supplies the runtime envelope.
- `skills/plain-report/SKILL.md` — read before changing Final report style, reviewer `why`/`change` prose rules, the telegraph-versus-Plain-report split, or surfaces that reference `plain-report`.
- `skills/grilling/SKILL.md` — read before changing natural-language adversarial interviews or the shared grilling contract.
- `skills/grill-me/SKILL.md`, `prompts/grill-me.md`, and `extensions/prompt-commands/index.ts` — read before changing explicit `/grill-me <plan>` behavior. The prompt entrypoint stays queueable and retains a functional no-Extension fallback while the active Extension preserves its raw multiline argument before normal expansion; the command skill permits only lock-gated, qualifying changes to `CONTEXT.md`, `CONTEXT-MAP.md`, and ADRs.
- `skills/showing-me/SKILL.md` and `prompts/show-me.md` — read before changing `/show-me`, its Explainer ladder, or where discardable HTML explainers are written.
- `skills/pr/SKILL.md` and `prompts/pr.md` — read before changing `/pr`, PR-body format, PR submission gates, or `rules/common/git-workflow.md` PR guidance.
- `extensions/execute/README.md` — read before changing `/execute`, Execution Brief reuse/synthesis, or execute orchestration behavior.
- `extensions/goal/README.md` — read before changing `/goal`, goal task mode, goal checkpoint behavior, goal status rendering, or Goal Extension registration.
- `extensions/init-deep/README.md` — read before changing `/init-deep` AGENTS.md generation behavior.
- `extensions/lsp/README.md` — read before changing the LSP tool or `/lsp` command behavior.
- `extensions/obsidian/README.md` — read before changing Obsidian vault activation, dynamic context-file discovery or precedence, guarded path behavior, provider injection, or `/obsidian` status output.
- `@yzlin/pieditor` — external npm-installed Pi package for editor UX behavior; `setup.sh` requires the compositor-free 2.0.0 release via `npm:@yzlin/pieditor@2.0.0`. Pi 0.84+ owns regular/fullscreen viewport composition; read `docs/adr/0002-use-pi-fullscreen.md` before adding editor-surface coordination.
- `extensions/tool-display/README.md` — read before changing tool renderer ownership, config, skill-file `read` override behavior, tool-display metadata, or RTK full-skill-read compaction exemptions. Also read `CONTEXT.md` "Tool rendering: implemented product direction" before changing tool rendering, `registerToolRenderer` use, the RTK/tool-display boundary, or drawing for companion and core tools (`Task*`, `mcp`/`mcp__*`, `codemode`, web tools).
- `extensions/rtk/README.md` — read before changing output compaction, `bash` ownership, or `/rtk` behavior.
- `extensions/smart-docs/README.md` — deprecated, disabled Extension; read before re-registering or removing `/smart-docs`.

## Maintenance rules

- List only real durable context boundaries here; avoid cataloging every file.
- Use plain-language `read before...` guidance for cross-cutting docs.
- Keep entries stable, source-grounded, and small.
- If an Extension is present but not registered, document it as disabled rather than active.
