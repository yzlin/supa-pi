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
- **`extensions/prompt-commands`** — active raw-input transformer for the queueable `/grill-me`, `/research-brief`, `/show-me`, and `/wayfinder` prompt entrypoints; canonical behavior remains in their delegated skills or prompt instructions
- **`extensions/ask`** — active Ask Extension providing the `ask` structured clarification tool and `/ask-stats` session command, with bounded schema, single/multi-question TUI flows, preview notes, validation, and locally documented rpiv divergences in `docs/context/ask.md`; no legacy tool or command aliases are registered
- **`extensions/context-docs`** — deterministic `/context-setup`, `/context-note`, `/adr`, and `/context-review` workflows for durable project context docs; canonical workflow behavior lives in `skills/context-docs/SKILL.md`
- **[`extensions/skill-router`](extensions/skill-router/README.md)** — registered-first, default-off paid JEV skill selection with bounded conversation transfer, separate authentication and explicit consent, and native fallback
- **`extensions/docs-list`** — `docs_list` tool for discovering project markdown docs before coding; backed by the same implementation as the `docs-list` CLI
- **`extensions/code-improvement`** — scoped `/simplify` code-simplifier delegation with strict target grammar, `--extra` guidance, `--yes` consent bypass for large/PR scopes, hard file allowlists, and `/improve-codebase-architecture` read-only architecture review workflow
- **`extensions/review`** — current-session `/review` prepares one public native workflow and locally validates publication via `review_finalize`, with `/review-summary` and `/review-fix` follow-ups (see `extensions/review/README.md`); adapted in part from `@earendil-works/pi-review`
- **`extensions/smart-docs`** — deterministic `/smart-docs` command flow for codebase documentation generation
- **`extensions/tool-display`** — compact tool renderers and the `read` override that returns exact loaded skill files in full, ignores pagination for those skill reads, and marks results so RTK does not compact them

The configured extension set also includes workflow and utility modules such as:

- `core-prompt` — main-agent orchestration and output guidance, including compact text diagrams when clarification is easier to scan visually
- `rules`
- `execute`
- `research`
- `code-improvement`
- `review.ts`
- `session-query`
- `handoff`
- `context`
- `btw`
- `tool-display`
- `skills`

See `package.json` for the full registration list.

## Included agents

`agents/` ships custom subagents for common coding workflows, including:

- `planner`
- `explorer` / `Explore`
- `architect`
- `researcher`
- `code-reviewer`
- `code-simplifier`
- `security-reviewer`
- `database-reviewer`
- `performance-reviewer`
- `executor`

## Included skills

`skills/` includes locally curated skills authored in this repo plus selected imports from Vercel agent-skills at commit `ce3e64e468f8fa09a2d075d102771838061fdac0`. Current imported-and-curated snapshots include `composition-patterns`, `react-best-practices`, `react-native-skills`, and `react-view-transitions`.

`skills/showing-me/SKILL.md` adapts the visual-explanation approach from HumanLayer's MIT-licensed [`show-me` skill](https://github.com/humanlayer/skills/blob/3c2629142c5d437428269b1b722b08c0b87f574d/plugins/show-me/skills/show-me/SKILL.md) at commit `3c2629142c5d437428269b1b722b08c0b87f574d`.

`skills/e2e-testing/SKILL.md` is the canonical main-session Playwright E2E workflow, including test guardrails, artifact handling, and reporting; no dedicated E2E agent is shipped.

Behavior changes and bug fixes use the canonical `skills/tdd-workflow/SKILL.md`, which also owns exact-command build reproduction, cascade/root-cause isolation, no-suppression, generated-source, and diagnostics-verification safeguards. Direct main-session work may use a concrete alternative to RED only for a reversible, low-impact change when it explains why RED is unavailable; meaningful regression and failure-path coverage plus required checks remain mandatory, and the exception does not cover security, payment, data-integrity, or irreversible work. During `/execute`, the managed TDD evidence contract remains unchanged; the generic executor receives the skill only through trusted `tdd: true` injection, and there is no separate TDD agent. Phased work validates each intermediate phase, while the final requested outcome must be usable.

`/execute` is a command-only entrypoint: an explicit invocation authorizes native `SubagentWorkflow` for that plan. It does not register retired execution tools or hooks. A stopped background workflow is controlled through `/agents` → `Workflows`; it is not automatically resumed or redispatched, and null worker results remain unresolved task records with blocker metadata.

`/diagnose` is diagnosis-only by default. An explicit diagnosis-and-fix request authorizes only a bounded local remedy after `Diagnosis: Proven`, with the disclosed scope and test plan; causal proof, targeted revalidation, and probe cleanup remain required.

Documentation and codemap work uses the canonical [`context-docs` Documentation and codemap safeguards](skills/context-docs/references/documentation-safeguards.md) for source truth, verified links and commands, scope, and freshness. Local durable-doc behavior remains canonical in `skills/context-docs/SKILL.md`: it owns durable-context routing, formats, commands, and persistence while preserving broad product/domain `CONTEXT.md` content, real `CONTEXT-MAP.md` boundaries, and full ADR semantics. The reusable `domain-modeling` skill is the canonical semantic primitive for terminology, scenarios, contradictions, boundaries, and ADR candidacy; context-docs consumes its completed packets without delegating them back. The shared `grilling` skill owns adversarial interviews, including natural-language triggers, and invokes domain-modeling only for explicit domain signals. `grill-me` is the thin wrapper used only by the explicit `/grill-me <plan>` command. It performs a docs-first preflight, drafts only `CONTEXT.md`, `CONTEXT-MAP.md`, or qualifying ADR changes, and writes them only after the user locks the plan. Domain-modeling adds no command or production runtime registration.

The canonical `wayfinder` skill carries unresolved decisions across sessions until a destination has a decision-ready route. Use `/wayfinder [idea | map]` to start or target a map; bare `/wayfinder` resumes the sole active map when unambiguous, otherwise asks what to use. It records versioned maps in `.pi/wayfinder/<name>/MAP.md` with separate authoritative question files, after verifying Git storage and obtaining approval for any required narrow ignore exception. It coordinates sequential ownership at the skill level, not runtime or atomic locking, and hands a completed decision summary to separate execution planning without implementing it or promoting it into canonical context.

Run `/skill` or `/skill list` in a custom UI session to open the Skills Manager. It shows managed and bundled/read-only skills, supports filtering, and includes a preview pane. Select a managed skill and press `d` directly (outside filter input) to remove it through the existing confirmation and trash flow (including dirty-file warnings); no Enter/action menu is needed. The panel returns with fresh inventory after removal or cancellation, preserving the filter. Bundled/read-only skills cannot be removed; panel install/update actions remain unavailable. In degraded or non-custom UI sessions, the same commands fall back to the simple text list. `/skill` commands show a Pi-like animated foreground activity widget while they load, search, install, update, or remove skills, then clear it before any follow-up prompt or notification. Existing `/skill search`, `/skill install`, `/skill update`, and `/skill remove` commands keep their previous prompt-based behavior. GitHub skill installs attempt authenticated skills.sh snapshots before falling back to immutable GitHub files. `/skill update` batches GitHub checks by repo with cached tree metadata, skips skills.sh snapshots, and materializes changed files from immutable GitHub content. When GitHub tree checks are rate-limited, cached trees locate known skills while current skill files still determine update status.

## Included prompts

`prompts/grill-me.md`, `prompts/research-brief.md`, `prompts/show-me.md`, and `prompts/wayfinder.md` provide queueable prompt entrypoints and complete `$@`-based fallbacks when Extensions are disabled or fail to load. Bare `/wayfinder` uses the fallback's default start-or-resume text. Before normal template expansion, `extensions/prompt-commands` replaces each invocation from its untouched raw argument substring; space-, tab-, and newline-separated arguments preserve their remaining layout, images, input source/events, and both steering and follow-up delivery. That raw argument preservation applies only while the transformer is active; the standalone fallback uses Pi's normal template expansion. Queue interception is removed when its final Extension owner shuts down, so reloads use current code without leaving a process-wide transformer behind. `/grill-me`, `/show-me`, and `/wayfinder` delegate canonical behavior to the `grill-me`, `showing-me`, and `wayfinder` skills respectively.

`prompts/wait-what.md` adapts Matt Pocock's MIT-licensed [`skills/productivity/wait-what/SKILL.md`](https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/skills/productivity/wait-what/SKILL.md) at commit `84fdeffd12f2ee307994d1eb6feb48173b6e0502`.

`extensions/context-docs/prompt.md` is the narrow runtime envelope for the canonical context-docs skill; it does not duplicate command behavior.

The local grilling, wrapper, and domain-modeling guidance is adapted—not copied verbatim—from Matt Pocock's MIT-licensed [`skills`](https://github.com/mattpocock/skills) repository at commit [`9603c1cc8118d08bc1b3bf34cf714f62178dea3b`](https://github.com/mattpocock/skills/tree/9603c1cc8118d08bc1b3bf34cf714f62178dea3b), specifically `skills/productivity/grilling`, `skills/productivity/grill-me`, `skills/engineering/grill-with-docs`, and `skills/engineering/domain-modeling`.

The implemented `domain-modeling` skill also carries direct provenance to Matt Pocock's MIT-licensed [`skills/engineering/domain-modeling/SKILL.md`](https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/skills/engineering/domain-modeling/SKILL.md) at immutable commit `84fdeffd12f2ee307994d1eb6feb48173b6e0502`.

The `wayfinder` skill is adapted from Matt Pocock's MIT-licensed [`skills/engineering/wayfinder/SKILL.md`](https://github.com/mattpocock/skills/blob/74ca5fe077456a0b3b2f5310cf9430999fd0b5fd/skills/engineering/wayfinder/SKILL.md) at pinned commit `74ca5fe077456a0b3b2f5310cf9430999fd0b5fd`; its retained MIT notice is [`skills/wayfinder/LICENSE.upstream`](skills/wayfinder/LICENSE.upstream).

`extensions/code-improvement/IMPROVE-CODEBASE-ARCHITECTURE.md` plus its uppercase support docs (`LANGUAGE.md`, `DEEPENING.md`, and `INTERFACE-DESIGN.md`) adapt Matt Pocock's `improve-codebase-architecture` workflow, licensed under the MIT License, from https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md

## Included rules

`rules/` provides shared guidance for:

- **common** workflows
- **TypeScript**
- **Python**
- **Swift**

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

1. create `~/.pi/agent` and `~/.pi/agent/settings.json` if missing
2. install companion Pi packages
3. install this checkout's locked production dependencies with Bun
4. register this checkout as a Pi local-path package
5. symlink this repo's `AGENTS.global.md` as `~/.pi/agent/AGENTS.md`, plus `keybindings.json`, `agents/`, `prompts/`, and `rules/` into the live Pi agent directory

The locked checkout dependencies are installed before local-path registration because Pi does not install dependencies for local sources. Registration still happens before prompt links are reconciled, so extension command replacements are deployed before retired prompt entrypoints are removed during upgrades. Setup fails immediately if dependency installation fails.

Fresh setup uses Pi's official fullscreen TUI by default. Existing `settings.json` files are left untouched; existing users can select fullscreen via `/settings` or start Pi with `--tui-mode fullscreen`. Both regular and fullscreen modes are supported.

After setup, restart Pi to pick up the changes.

### Existing subagents registration migration

If an older live config still registers the fork runtime, run `pi remove npm:@yzlin/pi-subagents` when that registration is present, rerun `./setup.sh`, and restart Pi. Verify `pi list` contains only the upstream `npm:@tintinweb/pi-subagents` subagents runtime. The unused fork SDK dependency has been removed: execute and review use public tools from the setup/global upstream companion, without adding a repository npm dependency on that runtime. The duplicate-fork setup guard remains. This is manual migration guidance, not a claim that live settings were changed.

## Companion packages installed by setup

The setup script installs or reconciles these Pi packages. It no longer installs `pi-skill-palette`; uninstall that global package yourself if it is still present from an older setup.

- `npm:@yzlin/pieditor@2.0.0` — exact required compositor-free release
- `@tintinweb/pi-subagents`
- `pi-mcp-adapter`
- `pi-rewind`
- `pi-web-access`
- `@plannotator/pi-extension`
- `glimpseui`
- `pi-anycopy`
- `pi-token-burden`
- `@tintinweb/pi-tasks`

## Development notes

- Extension registration lives in `package.json`
- Installing this package globally exposes `docs-list`, which runs `scripts/docs-list.ts` against the current working directory's `docs/` folder.
- Active Pi registers `docs_list`, a tool for the same docs-discovery behavior. It defaults to `cwd/docs`, accepts an optional safe relative docs path, strips a leading `@`, rejects absolute or escaping paths, skips `archive` and `research` directories, and returns readable output plus structured doc metadata and front matter warnings.
- Use `docs_list` first when it is available; otherwise run `docs-list` or inspect the docs folder directly before coding.
- Formatting/linting is configured via `biome.jsonc`
- Biome scripts:
  - `bun run format`
  - `bun run lint`
  - `bun run lint:fix`
  - `bun run check`
  - `bun run check:write`
- This repo uses Bun (`bun.lock` present)
- Peer dependencies include:
  - `@earendil-works/pi-coding-agent` (`>=0.86.1`)
  - `@earendil-works/pi-ai` (`>=0.86.1`)
  - `@earendil-works/pi-tui` (`>=0.86.1`)
  - `typebox` (`^1.1.34`)
- Pi version policy: consumers must provide Pi `0.86.1` or newer. Local development pins `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` together at exactly `0.86.1`; upgrade that set together and regenerate `bun.lock`.

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
