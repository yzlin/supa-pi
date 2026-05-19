# CONTEXT

## Product purpose

`supa-pi` is Ethan's personal-but-reusable Pi agent harness. It curates local Pi extensions, specialized agents, reusable skills, prompt templates, and rule packs to make Pi sessions more capable and consistent.

The repository is optimized for local workflow quality and maintainable agent behavior, not public-package stability.

## Domain model

- **Extension** — a Pi runtime module registered through `package.json -> pi.extensions`. Extensions add commands, tools, UI behavior, or workflow prompts.
- **Command** — a slash-command interface exposed by an Extension.
- **Agent** — a specialized subagent definition under `agents/` used for delegated work.
- **Skill** — reusable task-specific instructions under `skills/` or imported skill locations.
- **Rule pack** — coding, testing, security, or workflow guidance under `rules/`.
- **Prompt template** — durable prompt text under `prompts/` or an extension-local prompt file.
- **Setup script** — `setup.sh`, which prepares the live Pi agent environment.
- **Companion package** — external Pi package installed by `setup.sh` to extend the local harness.

## Domain glossary

- **Active Extension** — an Extension currently listed in `package.json -> pi.extensions`.
- **Disabled Extension** — extension code present in the repo but not listed in `package.json -> pi.extensions`.
- **Live Pi config** — the runtime Pi agent directory under `~/.pi/agent`.
- **Development clone** — any checkout used for editing this repo. It does not have to be `~/.pi/agent`.
- **Matt-compatible context docs** — `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/`, and optional `docs/context/` notes.

## Product constraints

- Keep extension boundaries isolated. Extensions under `extensions/` should not import from sibling extensions unless explicitly refactored into shared non-extension code.
- Prefer small, durable Markdown context over chat-only decisions.
- Develop anywhere, but treat `~/.pi/agent` as the live Pi config location described by setup docs.
- Do not document secrets, credentials, tokens, private keys, or raw sensitive logs.
- Root project license is MIT. Copied or adapted upstream materials must carry source and license notices in durable docs or README entries.

## Open questions

- None currently documented.

## Context map

See `CONTEXT-MAP.md`.
