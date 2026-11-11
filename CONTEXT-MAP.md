# CONTEXT-MAP

## Read first

- `CONTEXT.md` — read before changing product language, extension registration, setup behavior, licensing notes, or durable context docs.
- `AGENTS.md` — read before coding in this repo; contains project workflow, docs, verification, and deletion guardrails.
- `extensions/AGENTS.md` — read before changing any Extension under `extensions/`; contains extension-boundary and validation rules.
- `skills/domain-modeling/SKILL.md` — read before changing domain terminology, scenario testing, contradiction handling, boundary analysis, ADR candidacy, or domain-modeling composition with other skills.

## Architecture decisions

- `docs/adr/` — proposed, accepted, superseded, deprecated, or rejected tradeoff decisions.
- `docs/adr/0001-local-unified-edit-dialect.md` — read before changing the tool-display edit schema, unified-edit dialect, edit mutation safety, compatibility policy, or the live reliability gate (status: proposed). Gate status and pilot results live in `evals/unified-edit-reliability/README.md`.
- `docs/adr/0002-use-pi-fullscreen.md` — read before changing Pi version support, setup TUI defaults, fullscreen/regular compatibility, or pieditor viewport ownership.
- `docs/adr/0003-main-executed-execute-attempts.md` — read before changing `/execute` start or verify rules, the `executor` ledger field, main-attempt guards, or when `/execute` delegates to children (superseded by ADR 0005; history only).
- `docs/adr/0004-merged-review-verifier.md` — read before changing `/review` grouping, the verifier schema or prompt, rejected-candidate handling, or review model configuration (superseded by ADR 0005; history only).
- `docs/adr/0005-playbook-prose-gates.md` — read before moving `/execute`, `/review`, or `/goal` gates into Playbook prose, or deleting their enforcement code (accepted; supersedes 0003/0004).
- `evals/paired-path/README.md` — read before running or changing the old-vs-new execute and review comparison.

## Context notes

- `docs/context/` — longer durable notes that should not live in chat only.
- `docs/context/subsystems.md` — read before changing a subsystem named in its headings (oversight output, Sift, PR workflow, model profiles, codemode, tool rendering, retro, subagents, Spec workflow, local context overlay, Claude provider, statechart, formal verification skills, Playbooks, skill CLI); holds the implemented directions moved out of `CONTEXT.md`.
- `docs/context/extension-registration.md` — read before changing `package.json -> pi.extensions`, documenting active Extensions, or reasoning about disabled Extension code.
- `docs/context/ask.md` — read before changing the active Ask Extension, its public `ask` tool or `/ask-stats` command, schema/result shape, keyboard behavior, validation, or rpiv-divergence documentation.
- `docs/context/code-improvement.md` — read before changing `/simplify`, `/improve-codebase-architecture`, or code-improvement prompt files.
- `docs/context/model-routing.md` — read before checking or documenting current repository model defaults for setup, agents, review, evals, or Fast Mode; live settings and overrides may differ.
- `docs/context/enforced-rules.md` — read before running `/correct`, adding or weakening a contract test or tool refusal, or when a user corrects the same agent mistake twice.
- `docs/context/gpt-5.6-harness-optimization.md` — read before interpreting historical GPT-5.6 reasoning, service-tier, prompt, caching, tool-surface, or eval evidence.
- `docs/context/gpt-6-astra-harness-readiness.md` — read before interpreting historical Astra approvals and comparisons, or planning an approval-gated Astra eval or full-stack probe.
- `docs/context/harness-contract-audit.md` — read before changing research-artifact ownership, researcher dispatch in the investigation Playbook, or instruction ownership across prompts, agents, skills, and rules; preserves historical audit evidence and deferred live-calibration gates.
- `docs/context/upstream-companion-history.md` — read before interpreting historical `@tintinweb/pi-subagents`/`@tintinweb/pi-tasks` execution or public-workflow review decisions; not active instructions.
- `skills/review-orchestration/SKILL.md`, its `*.schema.json`, and `skills/supapi-mode/playbooks/fix-review-findings.md` — read before changing `/review`, `/review-fix`, reviewer or verifier agents, or review report shape.
- `extensions/trust-github-repos/README.md` — read before changing GitHub-owner auto-trust, `/trust-github-repos`, its global owners config, fail-closed behavior, or stored-trust boundaries.

## Major extension docs

- `extensions/subagent/README.md` — read before changing blocking delegation, trusted parent agent discovery, role controls/settings precedence, task-only children, reporting/evidence, cancellation, or tmux/Pi lifecycle boundaries.
- `extensions/model-profiles/README.md` — read before changing `/profile`, `model-profiles.json`, Generated agent overrides, or live `~/.pi/agent/agents` file ownership.
- `extensions/auto-rename/README.md` — read before changing automatic session naming, `/auto-rename`, its global configuration, title safety/privacy boundaries, or session/tree concurrency protections.
- `extensions/sift/README.md` — read before changing Sift, `sift_files`, `/sift`, TypeSafe authentication/consent, data-transfer limits, or its security boundary.
- `extensions/caveman/README.md` — read before changing `/caveman`, caveman-mode persistence, or generic extension status behavior.
- `extensions/fast/README.md` and `docs/context/extension-registration.md` — read before changing `/fast`, `--fast`, Fast Mode persistence, provider payload patching, model `fastMode: true` metadata, or Fast Mode status rendering.
- `docs/context/code-improvement.md` — read before changing `/simplify` behavior, scoped simplify boundaries, or `/improve-codebase-architecture` explorer delegation.
- `extensions/diagnose/README.md` and `skills/diagnose/SKILL.md` — read before changing `/diagnose`, its evidence-first diagnosis contract, temporary probe consent, or the explicit post-Proven fix gate.
- `extensions/code-improvement/IMPROVE-CODEBASE-ARCHITECTURE.md` — read before changing `/improve-codebase-architecture` architecture review behavior.
- `skills/context-docs/SKILL.md` and `extensions/context-docs/README.md` — read before changing `/context-setup`, `/context-note`, `/adr`, or `/context-review`; the skill canonically owns shared and command-specific behavior while the extension supplies the runtime envelope.
- `skills/plain-report/SKILL.md` — read before changing Final report style, reviewer `why`/`change` prose rules, the telegraph-versus-Plain-report split, or surfaces that reference `plain-report`.
- `evals/plain-report/README.md` — read before changing the offline Plain report calibration linter, its rules, or its fixtures.
- `skills/grilling/SKILL.md` — read before changing natural-language adversarial interviews or the shared grilling contract.
- `docs/context/subsystems.md` "Playbook architecture: implemented; ADR 0005 accepted", `skills/supapi-mode/`, and `rules/principles/` — read before adding the Hub skill, Playbooks, Principles, the core-prompt routing pointer, or converting commands into Playbooks.
- `skills/grill-me/SKILL.md`, `prompts/grill-me.md`, and `extensions/prompt-commands/index.ts` — read before changing explicit `/grill-me <plan>` behavior. The prompt entrypoint stays queueable and retains a functional no-Extension fallback while the active Extension preserves its raw multiline argument before normal expansion; the command skill permits only lock-gated, qualifying changes to `CONTEXT.md`, `CONTEXT-MAP.md`, and ADRs.
- `skills/showing-me/SKILL.md` and `prompts/show-me.md` — read before changing `/show-me`, its Explainer ladder, or where discardable HTML explainers are written.
- `skills/why/SKILL.md` and `prompts/why.md` — read before changing `/why`, its evidence tiers, or which sources it searches by default.
- `skills/teach/SKILL.md` and `prompts/teach.md` — read before changing `/teach` or how it reuses the investigation how-it-works step and `why`.
- `skills/ketchup/SKILL.md` and `prompts/ketchup.md` — read before changing `/ketchup`, what counts as an action item, or how it differs from `/wait-what`.
- `skills/blast-radius/SKILL.md` and `prompts/blast-radius.md` — read before changing `/blast-radius`, its proof ladder, or where its probes run.
- `prompts/statechart.md` and `docs/context/subsystems.md` "Statechart: implemented direction" — read before changing `/statechart`, the external statechart skill install, `/skill install` file-mode handling, or state-diagram guidance in `skills/architecture-diagrams/SKILL.md`.
- `prompts/create-formal-verification-skill.md`, `prompts/maintain-formal-verification-skill.md`, and `docs/context/subsystems.md` "Formal verification skills: implemented direction" — read before changing the external formal verification skill installs, generated verify skills, or wiring them into `/review` or `/context-review`.
- `docs/context/subsystems.md` "Skill CLI: implemented direction", `extensions/skills/ops.ts`, and `extensions/skills/core.ts` — read before changing `/skill`, the `pi-skill` CLI (`scripts/pi-skill.ts`), the shared Prompter-based skill orchestration, or skill-manifest write locking.
- `skills/supapi-mode/playbooks/opening-a-pr.md` and `prompts/pr.md` — read before changing `/pr`, PR-body format, PR submission gates, or `rules/common/git-workflow.md` PR guidance.
- `skills/retro/SKILL.md` and `prompts/retro.md` — read before changing `/retro`, session selection and evidence, report-only boundaries, or agent-environment recommendation routing.
- `skills/supapi-mode/playbooks/triage.md` and the hub `**Unit loop:**` rule in `skills/supapi-mode/SKILL.md` — read before changing how requests pick a Playbook or a size tier, the hard triggers, escalation, or the shared build loop; the triage eval cases live in `evals/paired-path/cases.ts`.
- `skills/supapi-mode/playbooks/execute.md` and `prompts/execute.md` — read before changing `/execute` or execute orchestration behavior.
- `skills/to-spec/SKILL.md` and `extensions/spec-log/README.md` — read before changing `/to-spec`, Spec format, Spec log, Snapshot refs, or Spec resume.
- `extensions/goal/README.md` — read before changing `/goal`, goal task mode, goal checkpoint behavior, goal status rendering, or Goal Extension registration.
- `extensions/init-deep/README.md` — read before changing `/init-deep` AGENTS.md generation behavior.
- `extensions/lsp/README.md` — read before changing the LSP tool or `/lsp` command behavior.
- `extensions/obsidian/README.md` — read before changing Obsidian vault activation, dynamic context-file discovery or precedence, guarded path behavior, context injection, or `/obsidian` status output.
- `extensions/agents-local/README.md` — read before changing `AGENTS.local.md` loading, Local context file discovery/order, the contextFiles mutation, or the -nc opt-out.
- `@yzlin/pieditor` — external npm-installed Pi package for editor UX behavior; `setup.sh` requires the compositor-free 2.0.0 release via `npm:@yzlin/pieditor@2.0.0`. Pi 0.84+ owns regular/fullscreen viewport composition; read `docs/adr/0002-use-pi-fullscreen.md` before adding editor-surface coordination.
- `extensions/tool-display/README.md` — read before changing tool renderer ownership, config, skill-file `read` override behavior, tool-display metadata, or RTK full-skill-read compaction exemptions. Also read `docs/context/subsystems.md` "Tool rendering: implemented product direction" before changing tool rendering, `registerToolRenderer` use, the RTK/tool-display boundary, or drawing for companion and core tools (`mcp__*`, `codemode`, web tools), retired-task fallback, or non-owned subagent rendering.
- `extensions/whimsical/README.md` — read before changing `/whimsical`, working-message sets, or custom set loading from `~/.pi/agent/whimsical/`.
- `extensions/rtk/README.md` — read before changing output compaction, `bash` ownership, or `/rtk` behavior.

## Maintenance rules

- List only real durable context boundaries here; avoid cataloging every file.
- Use plain-language `read before...` guidance for cross-cutting docs.
- Keep entries stable, source-grounded, and small.
- If an Extension is present but not registered, document it as disabled rather than active.
