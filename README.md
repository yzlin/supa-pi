# supa-pi

Ethan's `pi` coding agent harness.

This repo is a curated `~/.pi/agent` setup with local extensions, custom agents, reusable skills, prompts, and rule files for running a more capable Pi environment.

## What this repo contains

- **Custom extensions** registered in `package.json -> pi.extensions`
- **Specialized agents** under `agents/`
- **Reusable skills** under `skills/`
- **Prompt templates** under `prompts/`
- **Rule packs** under `rules/`
- **Setup script** in `setup.sh` for installing companion Pi packages and linking repo content into your live Pi config

## Notable extensions

Documented extensions in this repo include:

- **`extensions/lsp`** — unified `lsp` tool for diagnostics, definitions, references, hover, symbols, call hierarchy, and code actions
- **`extensions/rtk`** — output compaction and `/rtk stats` dashboard; owns `bash` execution, rewrite, and stats
- **`extensions/caveman`** — standalone `/caveman` mode with per-session persistence and generic extension status
- **`@yzlin/pieditor` 2.0.0** — required compositor-free npm package for editor UX improvements like `@` file picking, shell completions, raw paste, and command remapping; installed by `setup.sh`
- **`extensions/init-deep`** — deterministic `/init-deep` command flow for generating hierarchical `AGENTS.md`
- **`extensions/prompt-commands`** — active raw-input transformer for the queueable `/grill-me` and `/show-me` prompt entrypoints; canonical behavior remains in their delegated skills or prompt instructions
- **`extensions/ask`** — active Ask Extension providing the `ask` structured clarification tool and `/ask-stats` session command, with bounded schema, single/multi-question TUI flows, preview notes, validation, and locally documented rpiv divergences in `docs/context/ask.md`; no legacy tool or command aliases are registered
- **`extensions/context-docs`** — deterministic `/context-setup`, `/context-note`, `/adr`, and `/context-review` workflows for durable project context docs; canonical workflow behavior lives in `skills/context-docs/SKILL.md`
- **[`extensions/skill-router`](extensions/skill-router/README.md)** — registered-first, default-off paid JEV skill selection with bounded conversation transfer, Pi-managed authentication and explicit consent, and native fallback
- **`extensions/docs-list`** — `docs_list` tool for discovering project markdown docs before coding; backed by the same implementation as the `docs-list` CLI
- **`extensions/code-improvement`** — scoped main-session `/simplify` with strict target grammar, `--extra` guidance, `--yes` consent bypass for large/PR scopes, hard file allowlists, and `/improve-codebase-architecture` read-only architecture review workflow (explorer delegation only for broad scope)
- **`extensions/tool-display`** — compact tool renderers and the `read` override that returns exact loaded skill files in full, ignores pagination for those skill reads, and marks results so RTK does not compact them

The configured extension set also includes workflow and utility modules such as:

- `core-prompt` — main-agent orchestration and output guidance, including compact text diagrams when clarification is easier to scan visually
- `rules`
- `subagent` — repo-owned blocking tmux/Pi child runner; see [its boundary](extensions/subagent/README.md)
- `execute`
- `research`
- `code-improvement`
- `session-query`
- `handoff`
- `context`
- `btw`
- `tool-display`
- `skills`

See `package.json` for the full registration list.

## Included agents

`agents/` ships custom subagents for common coding workflows, including:

- `explorer` / `Explore`
- `researcher`
- `code-reviewer`
- `security-reviewer`
- `database-reviewer`
- `performance-reviewer`
- `executor`

## Included skills

`skills/` includes locally curated skills authored in this repo plus selected imports from Vercel agent-skills at commit `ce3e64e468f8fa09a2d075d102771838061fdac0`. Current imported-and-curated snapshots include `composition-patterns`, `react-best-practices`, `react-native-skills`, and `react-view-transitions`.

`skills/showing-me/SKILL.md` adapts the visual-explanation approach from HumanLayer's MIT-licensed [`show-me` skill](https://github.com/humanlayer/skills/blob/3c2629142c5d437428269b1b722b08c0b87f574d/plugins/show-me/skills/show-me/SKILL.md) at commit `3c2629142c5d437428269b1b722b08c0b87f574d`.

`skills/supapi-mode/SKILL.md` is the hub router. The core prompt sends non-trivial engineering work to it; it matches one Playbook under `skills/supapi-mode/playbooks/` (investigation, diagnose, bug-fix, feature, refactoring, prototype, opening-a-pr) and falls back to `skills/figure-it-out/SKILL.md` when none fits. Playbooks are step files, not separate skills. The shape is adapted from Lauren Tan's MIT-licensed [pstack](https://github.com/cursor/plugins/tree/main/pstack).

`skills/e2e-testing/SKILL.md` is the canonical main-session Playwright E2E workflow, including test guardrails, artifact handling, and reporting; no dedicated E2E agent is shipped.

Behavior changes and bug fixes use the canonical `skills/tdd-workflow/SKILL.md`, which also owns exact-command build reproduction, cascade/root-cause isolation, no-suppression, generated-source, and diagnostics-verification safeguards. Direct main-session work may use a concrete alternative to RED only for a reversible, low-impact change when it explains why RED is unavailable; meaningful regression and failure-path coverage plus required checks remain mandatory, and the exception does not cover security, payment, data-integrity, or irreversible work. During `/execute`, main supplies worker-accessible TDD guidance in the self-contained task; there is no trajectory-enforcement hook or separate TDD agent. Phased work validates each intermediate phase, while the final requested outcome must be usable.

`/execute` is a thin alias (`prompts/execute.md`) to the `execute` Playbook. Main lints and accepts a Spec, runs units itself or through blocking `executor` children, verifies each Done Criterion itself, and records it with the `spec_log` tool; `/to-spec status` shows the checkboxes. Since P4 no runtime gate enforces scope, repair limits, or verification; see `extensions/spec-log/README.md`.

`/diagnose` is diagnosis-only by default. An explicit diagnosis-and-fix request authorizes only a bounded local remedy after `Diagnosis: Proven`, with the disclosed scope and test plan; causal proof, targeted revalidation, and probe cleanup remain required.

Documentation and codemap work uses the canonical [`context-docs` Documentation and codemap safeguards](skills/context-docs/references/documentation-safeguards.md) for source truth, verified links and commands, scope, and freshness. Local durable-doc behavior remains canonical in `skills/context-docs/SKILL.md`: it owns durable-context routing, formats, commands, and persistence while preserving broad product/domain `CONTEXT.md` content, real `CONTEXT-MAP.md` boundaries, and full ADR semantics. The reusable `domain-modeling` skill is the canonical semantic primitive for terminology, scenarios, contradictions, boundaries, and ADR candidacy; context-docs consumes its completed packets without delegating them back. The shared `grilling` skill owns adversarial interviews, including natural-language triggers, and invokes domain-modeling only for explicit domain signals. `grill-me` is the thin wrapper used only by the explicit `/grill-me <plan>` command. It performs a docs-first preflight, drafts only `CONTEXT.md`, `CONTEXT-MAP.md`, or qualifying ADR changes, and writes them only after the user locks the plan. Domain-modeling adds no command or production runtime registration.


The canonical `retro` skill is an explicit-only, report-only review of selected Pi sessions. It proposes evidence-backed changes to the agent environment, not product code, and never starts an audit or applies repairs automatically.

Run `/skill` or `/skill list` in a custom UI session to open the Skills Manager. It shows managed and bundled/read-only skills, supports filtering, and includes a preview pane. Select a managed skill and press `d` directly (outside filter input) to remove it through the existing confirmation and trash flow (including dirty-file warnings); no Enter/action menu is needed. The panel returns with fresh inventory after removal or cancellation, preserving the filter. Bundled/read-only skills cannot be removed; panel install/update actions remain unavailable. In degraded or non-custom UI sessions, the same commands fall back to the simple text list. `/skill` commands show a Pi-like animated foreground activity widget while they load, search, install, update, or remove skills, then clear it before any follow-up prompt or notification. Existing `/skill search`, `/skill install`, `/skill update`, and `/skill remove` commands keep their previous prompt-based behavior. GitHub skill installs attempt authenticated skills.sh snapshots before falling back to immutable GitHub files. `/skill update` batches GitHub checks by repo with cached tree metadata, skips skills.sh snapshots, and materializes changed files from immutable GitHub content. When GitHub tree checks are rate-limited, cached trees locate known skills while current skill files still determine update status.

To manage skills from a shell without a Pi session, use `pi-skill` (`scripts/pi-skill.ts`; `setup.sh` links it to `~/.local/bin/pi-skill`). It shares the `/skill` logic through `extensions/skills/ops.ts`: `pi-skill list [--json]`, `search <query>`, `install <source> [--skill <name>]... [--all]`, `update [name] [--all]`, and `remove <name>`. On a TTY it asks with plain prompts. Off a TTY, pass `--yes`, `--all`, or `--skill <name>` for each choice; a missing choice exits with code 2 and names the flag. Operation failures exit 1. A running session picks up changes after `/reload`.

zsh completion lives in `scripts/completions/_pi-skill`; `setup.sh` links it to `~/.config/zsh/functions/_pi-skill`, which must be on `fpath`. Run `exec zsh` after setup. It completes commands, flags, local directories for `install`, and installed skill ids for `update` and `remove` (through the hidden `pi-skill __complete-names`).

## Included prompts

`prompts/grill-me.md` and `prompts/show-me.md` provide queueable prompt entrypoints and complete `$@`-based fallbacks when Extensions are disabled or fail to load. Before normal template expansion, `extensions/prompt-commands` replaces each invocation from its untouched raw argument substring; space-, tab-, and newline-separated arguments preserve their remaining layout, images, input source/events, and both steering and follow-up delivery. That raw argument preservation applies only while the transformer is active; the standalone fallback uses Pi's normal template expansion. Queue interception is removed when its final Extension owner shuts down, so reloads use current code without leaving a process-wide transformer behind. `/grill-me` and `/show-me` delegate canonical behavior to the `grill-me` and `showing-me` skills respectively.

`/pr [--base <branch>]` delegates through the plain `prompts/pr.md` alias to the `opening-a-pr` Playbook (`skills/supapi-mode/playbooks/opening-a-pr.md`), not the prompt-commands transformer. It checks branch state, gathers real evidence, and drafts a Why/Summary/Scope/Evidence/Merge Danger body with optional Tradeoffs. One confirmation covers push and PR creation or update, including any base retarget. GitHub CLI commands target origin's repository.

`/review [target]` delegates through the plain `prompts/review.md` alias to the report-only `review-orchestration` skill. It fans out reviewer subagents, has `review-verifier` check every candidate, and prints the report with a Fix Queue; it applies no fixes. `/review-fix` delegates through `prompts/review-fix.md` to the `fix-review-findings` Playbook, which triages each finding as fix, dismiss, or ask and fixes in one wave. Since P3 no extension backs either command, so stale or replayed reports are not detected.

`/retro [<session path | "last N">] [-- focus]` delegates through the plain native `prompts/retro.md` template to `skills/retro/SKILL.md`, not the prompt-commands transformer. Bare `/retro` defaults to the current session after verifying its identity; the newest file is only a candidate, and ambiguity requires clarification. Select sessions from the current cwd, honoring the configured Pi agent directory; use `"last N"` for a cohort and `-- focus` to narrow the review. Selected session contents are read through `session_query`. Run `/reload` in an active Pi session to discover the skill and prompt after changes.

`/statechart [flow or spec]` delegates through the plain `prompts/statechart.md` template to the external `statechart` skill. That skill model-checks a TLA+ spec with TLC and draws a Mermaid statechart that marks each broken rule and its shortest bug path. It is not vendored here. Install it with `/skill install https://github.com/cursor/plugins/tree/main/pstack/skills/statechart`. Updates track upstream `main`, so review the skill after each `/skill update`. On its first run, the skill installs Java and TLC with mise, which needs network access. Without the skill, `/statechart` stops and prints the install command. Source: [cursor/plugins `pstack/skills/statechart`](https://github.com/cursor/plugins/tree/main/pstack/skills/statechart), MIT License, Copyright (c) 2026 Lauren Tan.

`/blast-radius [target]` delegates through the plain `prompts/blast-radius.md` alias to the `blast-radius` skill (`skills/blast-radius/SKILL.md`). It looks for breakage outside the diff (strings, data formats, other readers of the same files, flags, downstream code), finds the one fact the change is safe because of, and proves it with a probe that runs real code, grading it on a Said, Pointed, Walked, Ran, Reproduced ladder. It edits no source; probes go under `$TMPDIR/supa-pi-blast-radius/`. Adapted from Lauren Tan's MIT-licensed [pstack `blast-radius` skill](https://github.com/cursor/plugins/tree/main/pstack).

`/why [target] [question]` delegates through the plain `prompts/why.md` alias to the read-only `why` skill (`skills/why/SKILL.md`). It builds a git anchor (blame, `log --follow`, `log -S`, PR text), reads `CONTEXT.md`, ADRs, tests, and nearby docs, grades each claim Direct, Supported, Inferred, Speculative, or Unknown, and reports gaps and sources consulted. Outside sources (tickets, chat, logs) are searched only on request. Adapted from Lauren Tan's MIT-licensed [pstack `why` skill](https://github.com/cursor/plugins/tree/main/pstack), reduced to git and in-repo sources.

`prompts/wait-what.md` adapts Matt Pocock's MIT-licensed [`skills/productivity/wait-what/SKILL.md`](https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/skills/productivity/wait-what/SKILL.md) at commit `84fdeffd12f2ee307994d1eb6feb48173b6e0502`.

`extensions/context-docs/prompt.md` is the narrow runtime envelope for the canonical context-docs skill; it does not duplicate command behavior.

The local grilling, wrapper, and domain-modeling guidance is adapted—not copied verbatim—from Matt Pocock's MIT-licensed [`skills`](https://github.com/mattpocock/skills) repository at commit [`9603c1cc8118d08bc1b3bf34cf714f62178dea3b`](https://github.com/mattpocock/skills/tree/9603c1cc8118d08bc1b3bf34cf714f62178dea3b), specifically `skills/productivity/grilling`, `skills/productivity/grill-me`, `skills/engineering/grill-with-docs`, and `skills/engineering/domain-modeling`.

The implemented `domain-modeling` skill also carries direct provenance to Matt Pocock's MIT-licensed [`skills/engineering/domain-modeling/SKILL.md`](https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/skills/engineering/domain-modeling/SKILL.md) at immutable commit `84fdeffd12f2ee307994d1eb6feb48173b6e0502`.


The `retro` skill adapts Matt Pocock's MIT-licensed [`skills/engineering/retro/SKILL.md`](https://github.com/mattpocock/skills/blob/a7d038f6bf7f01b516408e95e2fb56e0b338fa6f/skills/engineering/retro/SKILL.md) and a short inline lens from [`skills/productivity/writing-for-agents/SKILL.md`](https://github.com/mattpocock/skills/blob/a7d038f6bf7f01b516408e95e2fb56e0b338fa6f/skills/productivity/writing-for-agents/SKILL.md), both pinned to commit `a7d038f6bf7f01b516408e95e2fb56e0b338fa6f`. The retained MIT notice is [`skills/retro/LICENSE.upstream`](skills/retro/LICENSE.upstream).

The `opening-a-pr` Playbook (formerly the `pr` skill) is adapted from Matt Pocock's MIT-licensed in-progress [`skills/in-progress/pr`](https://github.com/mattpocock/skills/tree/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/in-progress/pr) at commit `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`.

`extensions/code-improvement/IMPROVE-CODEBASE-ARCHITECTURE.md` plus its uppercase support docs (`LANGUAGE.md`, `DEEPENING.md`, and `INTERFACE-DESIGN.md`) adapt Matt Pocock's `improve-codebase-architecture` workflow, licensed under the MIT License, from https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md

## Included rules

`rules/` provides shared guidance for:

- **common** workflows
- **TypeScript**
- **Python**
- **Swift**
- **principles** — one named engineering rule per file in `rules/principles/`, adapted from Lauren Tan's MIT-licensed [pstack](https://github.com/cursor/plugins/tree/main/pstack) `principle-*` skills (`rules/principles/LICENSE.upstream`). `AGENTS.global.md` points to them; Playbooks list the ones they apply.

Each language folder includes coding-style, patterns, security, and testing guidance. Shared security checks apply to directly or indirectly affected boundaries, while every commit still receives a diff check for secrets and sensitive-data exposure. Affected unsafe work stops, critical findings are reported, independent safe work may continue, and local work does not automatically rotate secrets or repair the whole repository. A scoped local implementation request includes its necessary tests without repeat consent; external, destructive, production, and credential actions remain separately gated. Mobile UI interaction stays with Argent MCP; `xcrun`/`adb` are limited to necessary device administration when MCP lacks that capability for the authorized target/task, not UI fallback.

The global agent protocol and common workflow rules include guidance adapted from `karpathy-guidelines`, licensed under MIT: https://github.com/multica-ai/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md

## Repository layout

```text
.
├── agents/
├── extensions/
├── prompts/
├── rules/
├── skills/
├── themes/
├── docs/
├── AGENTS.md
├── AGENTS.global.md
├── keybindings.json
├── package.json
└── setup.sh
```

## Install

This repo can live anywhere. `setup.sh` installs the checkout as a Pi local-path package, links repo-managed files into `~/.pi/agent`, and the bundled skills extension discovers this repo's `skills/` directory directly.

```bash
git clone git@github.com:yzlin/supa-pi ~/dev/yzlin/supa-pi
cd ~/dev/yzlin/supa-pi
./setup.sh
```

`setup.sh` will:

1. create `~/.pi/agent`, `~/.pi/agent/settings.json`, and `~/.pi/agent/subagent.json` (a `claude-code` providerExtensions entry) if missing
2. install companion Pi packages
3. install this checkout's locked production dependencies with Bun
4. register this checkout as a Pi local-path package
5. symlink this repo's `AGENTS.global.md` as `~/.pi/agent/AGENTS.md`, plus `keybindings.json`, `agents/`, `prompts/`, and `rules/` into the live Pi agent directory

The locked checkout dependencies are installed before local-path registration because Pi does not install dependencies for local sources. Registration still happens before prompt links are reconciled, so extension command replacements are deployed before retired prompt entrypoints are removed during upgrades. Setup fails immediately if dependency installation fails.

Fresh setup uses Pi's official fullscreen TUI by default. Setup skips settings initialization when `settings.json` exists and preserves existing TUI-mode preferences; package installation can still update the packages list. Existing users can select fullscreen via `/settings` or start Pi with `--tui-mode fullscreen`. Both regular and fullscreen modes are supported.

A fresh install defaults to `claude-code/claude-opus-5-5` through the `pi-claude-code` package, which needs a Claude subscription and the `claude` CLI.

After setup, restart Pi to pick up the changes.

### Existing delegation/task registration migration

Before rerunning setup or restarting Pi, manually remove **both** old registrations when present. These commands remove global registrations:

```bash
pi remove npm:@tintinweb/pi-subagents
pi remove npm:@tintinweb/pi-tasks
```

For project-local registrations, run `pi remove -l <exact-registered-source>` from each affected project root instead. Also remove `npm:@yzlin/pi-subagents` if the earlier fork remains registered, using the flag for its registration scope. Check `pi list` in each affected project and recheck global/project package registrations for duplicate old runtimes; setup does not uninstall or detect them. Then rerun `./setup.sh` and restart Pi with only the checkout's `./extensions/subagent` delegation runtime. No live settings/removal/setup action was performed by this repository migration. Old task/workflow records are not imported.

The new runner requires tmux, Pi 1.0.1+, and the full checkout (plus Bun for strict-skill children). It runs fresh task-only children in the shared checkout with four blocking slots per parent, trusted parent `.pi/agents` over global agents, and call > role > parent settings. Parallel writes require disjoint scopes. Tool controls are not an OS sandbox. Owner-only task/result/native-session evidence is saved under Pi's agent directory; finished tmux sessions are cleaned up. See [subagent](extensions/subagent/README.md) for cancellation, reporting, and isolated offline smoke boundaries. Independent whole-repository tests and `bun run check` verify the source cutover. Actual offline tmux/Pi children verify execution report binding and the reviewer/verifier publication boundary; an isolated SDK process loads the complete manifest. These deterministic fixtures do not prove paid-model quality or live deployment. Live setup/configuration is unmigrated; paid-model quality is not validated.

## Companion packages installed by setup

The setup script installs or reconciles these Pi packages. It no longer installs `pi-skill-palette`; uninstall that global package yourself if it is still present from an older setup.

- `npm:@yzlin/pieditor@2.0.0` — exact required compositor-free release
- `pi-rewind`
- `pi-web-access`
- `@plannotator/pi-extension`
- `glimpseui`
- `pi-anycopy`
- `pi-token-burden`
- `https://github.com/yzlin/pi-claude-code` — Claude subscription provider (`claude-code`; Ethan's fork of `earendil-works/pi-claude-code`)

## Development notes

- Extension registration lives in `package.json`
- Installing this package globally exposes `docs-list`, which runs `scripts/docs-list.ts` against the current working directory's `docs/` folder, and `pi-skill` (see the skills section).
- Active Pi registers `docs_list`, a tool for the same docs-discovery behavior. It defaults to `cwd/docs`, accepts an optional safe relative docs path, strips a leading `@`, rejects absolute or escaping paths, skips `archive` and `research` directories, and returns readable output plus structured doc metadata and front matter warnings.
- Discover relevant docs for unfamiliar project/domain context or when scoped instructions require it. Use `docs_list` when available; otherwise run `docs-list` or inspect the docs folder. Skip obvious typos, mechanical edits, and understood local changes unless scoped instructions require discovery.
- Linting uses type-aware oxlint; formatting uses oxfmt (TypeScript and JSON only). Both extend Ultracite presets with local overrides in `oxlint.config.ts` and `oxfmt.config.ts`.
- Development scripts:
  - `bun run format`
  - `bun run lint`
  - `bun run lint:fix`
  - `bun run check`
  - `bun run check:write`
- This repo uses Bun (`bun.lock` present)
- Runtime dependency `@earendil-works/pi-schema` (exactly `1.5.0`) validates subagent `StructuredOutput` reports with the same validator Pi uses for tool arguments.
- Peer dependencies include:
  - `@earendil-works/pi-coding-agent` (`>=1.0.1`)
  - `@earendil-works/pi-ai` (`>=1.0.1`)
  - `@earendil-works/pi-tui` (`>=1.0.1`)
  - `typebox` (`^1.1.34`)
- Pi version policy: consumers must provide Pi `1.0.1` or newer. Local development pins `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` together at exactly `1.5.0` (matching the live runtime), and the runtime `@earendil-works/pi-schema` dependency at the same version, because Pi does not share its copy with extensions; upgrade that set together and regenerate `bun.lock`.

## When to use this repo

Use this repo if you want a Pi setup with:

- stronger orchestration defaults
- local workflow extensions
- built-in research/PRD/review helpers
- custom skills and rules for multiple languages
- improved editor and memory ergonomics

## License / ownership

MIT. See [`LICENSE.md`](./LICENSE.md).

Copied or adapted upstream materials keep source and license notes near their usage.

The repo-owned [subagent runtime](extensions/subagent/README.md) adapts Armin Ronacher's Apache-2.0 [`mitsuhiko/agent-stuff` subagent extension](https://github.com/mitsuhiko/agent-stuff/blob/d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0/extensions/subagent.ts) at `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0`. Its full [upstream license](extensions/subagent/LICENSE.upstream) and [attribution/modification notice](extensions/subagent/NOTICE) are retained; the root MIT license is unchanged.
