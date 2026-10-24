# Agents-local extension

Loads personal, uncommitted `AGENTS.local.md` files (Local context files) next to Pi's native context files.

## Behavior

- Additive only. A Local context file never replaces or removes a native context file. `AGENTS.override.md` keeps its native meaning.
- Only the exact, case-sensitive name `AGENTS.local.md` counts. `CLAUDE.local.md` and other variants are ignored.
- Strips a UTF-8 BOM like native loading. Never fails discovery: an unreadable `AGENTS.local.md` (for example, permission denied) is skipped with a `Warning: Could not read ...` message like native loading; missing files and non-file entries (for example, a directory named `AGENTS.local.md`) are skipped silently.
- No size limits, commands, tools, or git checks.

Add `AGENTS.local.md` to your global gitignore (`~/.config/git/ignore`) so it stays uncommitted.

## Discovery

Mirrors Pi's native walk: the global agent dir (`getAgentDir()`, default `~/.pi/agent`), then every directory from `/` down to cwd.

- An orphan Local context file (no native file in its directory) still loads.
- Files are deduped by realpath, for example when cwd is the agent dir or through symlinks.
- Native nested-worktree shadowing is not copied, so the main repo's `AGENTS.local.md` still applies inside nested worktrees.

## Ordering

Each Local context file renders inside the native `<project_context>` block as `<project_instructions path=...>`:

- right after the native entry from the same directory, or
- when that directory has no native entry, at its parent-to-child slot: global, `/`, ..., cwd.

Native entries keep their order. Inserting is idempotent: a path already present is not added again.

## Timing

Files are scanned on every `session_start` with the current cwd and cached. Each run inserts the cached list without rereading files, so edits need `/reload`.

## Opt-out

Skipped when `process.argv` contains `--no-context-files` or `-nc`: no files are read and `contextFiles` is unchanged.

Known gap: SDK or RPC sessions created with `noContextFiles: true` are not detected, because Pi does not expose that flag to Extensions.

## Mechanism

In `before_agent_start`, the extension mutates `event.systemPromptOptions.contextFiles` in place. It does not use `sections`, `systemPrompt`, or `forceSystemPrompt`, so entries render through Pi's native context-file path. A real `createAgentSession` test verifies Pi renders the mutation.

Live `pi-claude-code` delivery is verified (2026-10-24): a fresh `pi -p` run on `claude-code/claude-sonnet-5-5` quoted a marker from a temporary `AGENTS.local.md`.
