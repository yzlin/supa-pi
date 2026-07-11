# AGENTS.md

## Project

- This repository is the source for Ethan's Pi agent harness; `~/.pi/agent` is the live configuration.
- Read `CONTEXT.md` before changing product language, setup behavior, extension registration, licensing notes, or durable context docs.
- Read the matching entries in `CONTEXT-MAP.md` before changing a documented subsystem.
- Use Bun for package scripts and tests.

## Extensions

- Read `extensions/AGENTS.md` before changing files under `extensions/`.
- Keep `package.json -> pi.extensions` and extension documentation aligned with active runtime registration.

## Validation

- Run targeted tests for changed behavior.
- Run `bun run check` before finishing code changes.
