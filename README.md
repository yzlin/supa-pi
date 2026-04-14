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
- **`extensions/om`** — Observational Memory for branch-local memory restore, observer/reflector passes, and `/om` admin commands
- **`extensions/rtk`** — output compaction and `/rtk stats` dashboard for `bash`, `grep`, and `read`
- **`extensions/pieditor`** — editor UX improvements like `@` file picking, shell completions, raw paste, command remapping, and a locally maintained fork lineage from the original upstream extension
- **`extensions/init-deep`** — deterministic `/init-deep` command flow for generating hierarchical `AGENTS.md`
- **`extensions/review.ts`** — interactive `/review` and `/end-review` workflow with reviewer-agent orchestration and branch-return summaries; adapted in part from `@earendil-works/pi-review`
- **`extensions/smart-docs`** — deterministic `/smart-docs` command flow for codebase documentation generation

The configured extension set also includes workflow and utility modules such as:

- `questionnaire`
- `core-prompt`
- `rules`
- `plan`
- `execute`
- `research`
- `simplify`
- `review.ts`
- `session-query`
- `handoff`
- `context`
- `btw`
- `ast-grep`
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
- `doc-updater`
- `e2e-runner`
- `refactor-cleaner`
- `executor`

## Included rules

`rules/` provides shared guidance for:

- **common** workflows
- **TypeScript**
- **Python**
- **Swift**

Each language folder includes coding-style, patterns, security, and testing guidance.

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
├── package.json
└── setup.sh
```

## Install

This repo expects to live at `~/.pi/agent`.

```bash
git clone git@github.com:yzlin/supa-pi ~/.pi/agent
cd ~/.pi/agent
./setup.sh
```

`setup.sh` will:

1. verify the repo is checked out at `~/.pi/agent`
2. create `~/.pi/agent/settings.json` if missing
3. install companion Pi packages with `pi install`
4. symlink this repo's `skills/`, `agents/`, `prompts/`, and `rules/` into the live Pi agent directory

After setup, restart Pi to pick up the changes.

## Companion packages installed by setup

The setup script installs these Pi packages if they are not already present:

- `@tintinweb/pi-subagents`
- `pi-mcp-adapter`
- `pi-rewind`
- `pi-web-access`
- `glimpseui`
- `pi-skill-palette`
- `pi-claude-bridge`
- `pi-anycopy`
- `pi-tool-display`
- `pi-promptsmith`
- `pi-token-burden`
- `@tintinweb/pi-tasks`

## Development notes

- Extension registration lives in `package.json`
- Formatting/linting is configured via `biome.jsonc`
- Biome scripts:
  - `bun run format`
  - `bun run lint`
  - `bun run lint:fix`
  - `bun run check`
  - `bun run check:write`
- This repo uses Bun (`bun.lock` present)
- Peer dependencies include:
  - `@mariozechner/pi-coding-agent`
  - `@mariozechner/pi-ai`
  - `@mariozechner/pi-tui`
  - `@sinclair/typebox`

## When to use this repo

Use this repo if you want a Pi setup with:

- stronger orchestration defaults
- local workflow extensions
- built-in research/planning/review helpers
- custom skills and rules for multiple languages
- improved editor and memory ergonomics

## License / ownership

No license file was found in the repo root during inspection. Add one if you want to publish or share this setup externally.
