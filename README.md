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
- **`extensions/prompt-commands`** — active raw-input transformer for the queueable `/grill-me`, `/research-brief`, and `/show-me` prompt entrypoints; canonical behavior remains in their delegated skills or prompt instructions
- **`extensions/questionnaire`** — active `ask` structured clarification tool and `/ask-stats` session command, with bounded schema, single/multi-question TUI flows, preview notes, validation, and locally documented rpiv divergences in `docs/context/questionnaire.md`; no `questionnaire` tool or `/questionnaire-stats` command aliases are registered
- **`extensions/context-docs`** — deterministic `/context-setup`, `/context-note`, `/adr`, and `/context-review` workflows for durable project context docs; canonical workflow behavior lives in `skills/context-docs/SKILL.md`
- **`extensions/docs-list`** — `docs_list` tool for discovering project markdown docs before coding; backed by the same implementation as the `docs-list` CLI
- **`extensions/code-improvement`** — scoped `/simplify` code-simplifier delegation with strict target grammar, `--extra` guidance, `--yes` consent bypass for large/PR scopes, hard file allowlists, and `/improve-codebase-architecture` read-only architecture review workflow
- **`extensions/review`** — interactive current-session `/review` workflow with `/review-summary` and `/review-fix` follow-ups plus reviewer-agent orchestration; adapted in part from `@earendil-works/pi-review`
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
- `build-error-resolver`
- `database-reviewer`
- `performance-reviewer`
- `doc-updater`
- `e2e-runner`
- `refactor-cleaner`
- `executor`

## Included skills

`skills/` includes locally curated skills authored in this repo plus selected imports from Vercel agent-skills at commit `ce3e64e468f8fa09a2d075d102771838061fdac0`. Current imported-and-curated snapshots include `composition-patterns`, `react-best-practices`, `react-native-skills`, and `react-view-transitions`.

`skills/showing-me/SKILL.md` adapts the visual-explanation approach from HumanLayer's MIT-licensed [`show-me` skill](https://github.com/humanlayer/skills/blob/3c2629142c5d437428269b1b722b08c0b87f574d/plugins/show-me/skills/show-me/SKILL.md) at commit `3c2629142c5d437428269b1b722b08c0b87f574d`.

Behavior changes and bug fixes use the canonical `skills/tdd-workflow/SKILL.md`. During `/execute`, the generic executor receives it only through trusted `tdd: true` skill injection; there is no separate TDD agent.

Local durable-doc behavior is canonical in `skills/context-docs/SKILL.md`. It alone owns durable-context routing, formats, commands, and persistence while preserving broad product/domain `CONTEXT.md` content, real `CONTEXT-MAP.md` boundaries, and full ADR semantics. The reusable `domain-modeling` skill is the canonical semantic primitive for terminology, scenarios, contradictions, boundaries, and ADR candidacy; context-docs consumes its completed packets without delegating them back. The shared `grilling` skill owns adversarial interviews, including natural-language triggers, and invokes domain-modeling only for explicit domain signals. `grill-me` is the thin wrapper used only by the explicit `/grill-me <plan>` command. It performs a docs-first preflight, drafts only `CONTEXT.md`, `CONTEXT-MAP.md`, or qualifying ADR changes, and writes them only after the user locks the plan. Domain-modeling adds no command or production runtime registration.

Run `/skill` or `/skill list` in a custom UI session to open the first-slice Skills Manager. It shows managed and bundled/read-only skills, supports filtering, and includes a preview pane with current action hints. In degraded or non-custom UI sessions, the same commands fall back to the simple text list. `/skill` commands show a Pi-like animated foreground activity widget while they load, search, install, update, or remove skills, then clear it before any follow-up prompt or notification. Existing `/skill search`, `/skill install`, `/skill update`, and `/skill remove` commands keep their previous prompt-based behavior. GitHub skill installs attempt authenticated skills.sh snapshots before falling back to immutable GitHub files. `/skill update` batches GitHub checks by repo with cached tree metadata, skips skills.sh snapshots, and materializes changed files from immutable GitHub content. When GitHub tree checks are rate-limited, cached trees locate known skills while current skill files still determine update status.

## Included prompts

`prompts/grill-me.md`, `prompts/research-brief.md`, and `prompts/show-me.md` provide queueable prompt entrypoints and complete `$@`-based fallbacks when Extensions are disabled or fail to load. Before normal template expansion, `extensions/prompt-commands` replaces each invocation from its untouched raw argument substring; space-, tab-, and newline-separated arguments preserve their remaining layout, images, input source/events, and both steering and follow-up delivery. Queue interception is removed when its final Extension owner shuts down, so reloads use current code without leaving a process-wide transformer behind. `/grill-me` and `/show-me` delegate canonical behavior to the `grill-me` and `showing-me` skills respectively.

`prompts/wait-what.md` adapts Matt Pocock's MIT-licensed [`skills/productivity/wait-what/SKILL.md`](https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/skills/productivity/wait-what/SKILL.md) at commit `84fdeffd12f2ee307994d1eb6feb48173b6e0502`.

`extensions/context-docs/prompt.md` is the narrow runtime envelope for the canonical context-docs skill; it does not duplicate command behavior.

The local grilling, wrapper, and domain-modeling guidance is adapted—not copied verbatim—from Matt Pocock's MIT-licensed [`skills`](https://github.com/mattpocock/skills) repository at commit [`9603c1cc8118d08bc1b3bf34cf714f62178dea3b`](https://github.com/mattpocock/skills/tree/9603c1cc8118d08bc1b3bf34cf714f62178dea3b), specifically `skills/productivity/grilling`, `skills/productivity/grill-me`, `skills/engineering/grill-with-docs`, and `skills/engineering/domain-modeling`.

The implemented `domain-modeling` skill also carries direct provenance to Matt Pocock's MIT-licensed [`skills/engineering/domain-modeling/SKILL.md`](https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/skills/engineering/domain-modeling/SKILL.md) at immutable commit `84fdeffd12f2ee307994d1eb6feb48173b6e0502`.

`extensions/code-improvement/IMPROVE-CODEBASE-ARCHITECTURE.md` plus its uppercase support docs (`LANGUAGE.md`, `DEEPENING.md`, and `INTERFACE-DESIGN.md`) adapt Matt Pocock's `improve-codebase-architecture` workflow, licensed under the MIT License, from https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md

## Included rules

`rules/` provides shared guidance for:

- **common** workflows
- **TypeScript**
- **Python**
- **Swift**

Each language folder includes coding-style, patterns, security, and testing guidance.

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

## Companion packages installed by setup

The setup script installs or reconciles these Pi packages. It no longer installs `pi-skill-palette`; uninstall that global package yourself if it is still present from an older setup.

- `npm:@yzlin/pieditor@2.0.0` — exact required compositor-free release
- `@yzlin/pi-subagents`
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
  - `@earendil-works/pi-coding-agent` (`>=0.84.0`)
  - `@earendil-works/pi-ai` (`>=0.84.0`)
  - `@earendil-works/pi-tui` (`>=0.84.0`)
  - `typebox` (`^1.1.34`)
- Pi version policy: consumers must provide Pi `0.84.0` or newer. Local development pins `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` together at exactly `0.84.0`; upgrade that set together and regenerate `bun.lock`.

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
