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
- **`extensions/om`** — disabled Observational Memory extension code for branch-local memory restore, observer/reflector passes, and `/om` admin commands; present in the repo but not registered in `package.json -> pi.extensions`
- **`extensions/rtk`** — output compaction and `/rtk stats` dashboard; owns `bash` execution, rewrite, and stats
- **`extensions/caveman`** — standalone `/caveman` mode with per-session persistence and generic extension status
- **`@yzlin/pieditor`** — npm-installed Pi package for editor UX improvements like `@` file picking, shell completions, raw paste, and command remapping; installed by `setup.sh`
- **`extensions/init-deep`** — deterministic `/init-deep` command flow for generating hierarchical `AGENTS.md`
- **`extensions/questionnaire`** — active structured clarification tool with bounded schema, single/multi-question TUI flows, preview notes, validation, and locally documented rpiv divergences in `docs/context/questionnaire.md`
- **`extensions/context-docs`** — deterministic `/context-setup`, `/context-note`, `/adr`, `/context-review`, and `/context-grill` workflows for durable project context docs
- **`extensions/docs-list`** — `docs_list` tool for discovering project markdown docs before coding; backed by the same implementation as the `docs-list` CLI
- **`extensions/code-improvement`** — scoped `/simplify` code-simplifier delegation with strict target grammar, `--extra` guidance, `--yes` consent bypass for large/PR scopes, hard file allowlists, and `/improve-codebase-architecture` read-only architecture review workflow
- **`extensions/review`** — interactive current-session `/review` workflow with `/review-summary` and `/review-fix` follow-ups plus reviewer-agent orchestration; adapted in part from `@earendil-works/pi-review`
- **`extensions/smart-docs`** — deterministic `/smart-docs` command flow for codebase documentation generation
- **`extensions/tool-display`** — compact tool renderers and the `read` override that returns exact loaded skill files in full, ignores pagination for those skill reads, and marks results so RTK does not compact them

The configured extension set also includes workflow and utility modules such as:

- `core-prompt`
- `rules`
- `execute`
- `research`
- `code-improvement`
- `review.ts`
- `session-query`
- `handoff`
- `context`
- `btw`
- `ast-grep`
- `tool-display`
- `skills`

See `package.json` for the full registration list.

## Included agents

`agents/` ships custom subagents for common coding workflows, including:

- `planner`
- `explorer` / `Explore`
- `architect`
- `researcher`
- `tdd-guide`
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

`skills/` includes locally curated skills authored in this repo plus selected imports from Vercel agent-skills at commit `ce3e64e468f8fa09a2d075d102771838061fdac0`. Current imported-and-curated snapshots include `composition-patterns`, `react-best-practices`, `react-native-skills`, and `react-view-transitions`. Local workflow skills include `grill-me` for natural-language adversarial design review triggers like "grill me" or "stress-test this plan", and `context-docs` for durable `CONTEXT.md`, `CONTEXT-MAP.md`, ADR, `/context-review`, and `/context-grill` workflows.

Run `/skill` or `/skill list` in a custom UI session to open the first-slice Skills Manager. It shows managed and bundled/read-only skills, supports filtering, and includes a preview pane with current action hints. In degraded or non-custom UI sessions, the same commands fall back to the simple text list. `/skill` commands show a Pi-like animated foreground activity widget while they load, search, install, update, or remove skills, then clear it before any follow-up prompt or notification. Existing `/skill search`, `/skill install`, `/skill update`, and `/skill remove` commands keep their previous prompt-based behavior.

## Included prompts

`prompts/to-prd.md` is adapted from Matt Pocock's `to-prd` skill: https://github.com/mattpocock/skills/blob/main/skills/engineering/to-prd/SKILL.md

`extensions/context-docs/prompt.md` is bundled with the context-docs extension and documents the Matt-compatible `CONTEXT.md`/`CONTEXT-MAP.md` scaffold, ADR shape, `/context-review` extraction rules, and `/context-grill` behavior.

`extensions/code-improvement/IMPROVE-CODEBASE-ARCHITECTURE.md` plus its uppercase support docs (`LANGUAGE.md`, `DEEPENING.md`, and `INTERFACE-DESIGN.md`) adapt Matt Pocock's `improve-codebase-architecture` workflow, licensed under the MIT License, from https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md

## Included rules

`rules/` provides shared guidance for:

- **common** workflows
- **TypeScript**
- **Python**
- **Swift**

Each language folder includes coding-style, patterns, security, and testing guidance.

The root agent protocol and common workflow rules include guidance adapted from `karpathy-guidelines`, licensed under MIT: https://github.com/multica-ai/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md

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
├── keybindings.json
├── package.json
└── setup.sh
```

## Install

This repo can live anywhere. `setup.sh` links repo-managed files into `~/.pi/agent` and the bundled skills extension discovers this repo's `skills/` directory directly.

```bash
git clone git@github.com:yzlin/supa-pi ~/dev/yzlin/supa-pi
cd ~/dev/yzlin/supa-pi
./setup.sh
```

`setup.sh` will:

1. create `~/.pi/agent` and `~/.pi/agent/settings.json` if missing
2. install companion Pi packages with `pi install`
3. symlink this repo's `keybindings.json`, `agents/`, `prompts/`, and `rules/` into the live Pi agent directory

After setup, restart Pi to pick up the changes.

## Companion packages installed by setup

The setup script installs these Pi packages if they are not already present. It no longer installs `pi-skill-palette`; uninstall that global package yourself if it is still present from an older setup.

- `@yzlin/pi-subagents`
- `pi-mcp-adapter`
- `pi-rewind`
- `pi-web-access`
- `glimpseui`
- `pi-claude-bridge`
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
  - `@earendil-works/pi-coding-agent`
  - `@earendil-works/pi-ai`
  - `@earendil-works/pi-tui`
  - `typebox` (`^1.1.34`)

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
