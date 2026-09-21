# Obsidian extension

Loads native Pi-compatible context files for configured Obsidian vaults.

## Configuration

Config lives at `~/.pi/agent/obsidian.json`:

```json
{
  "enabled": true,
  "vaults": [{ "path": "~/Vault", "name": "main" }]
}
```

Vault paths must be absolute, `~`, or `~/...`, and must contain a `.obsidian` directory.

## Activation

The extension is active only when Pi's cwd is inside a configured vault. If vaults overlap, the deepest vault root wins.

## Context loading

- Discovers one context file per directory from vault root to the target path.
- Uses native Pi precedence: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, then `CLAUDE.MD`.
- Uses realpath containment to reject paths outside the active vault.
- Loads parent-to-child context order.
- Persists loaded context paths in session entries only, keeping each directory's selection stable for the session.
- Injects loaded context into provider payloads, hidden from normal conversation history.
- Blocks guarded structured path tool calls when missing context is found; retry the same tool call after the next provider request includes the new context.
- Blocks context files over 64KB and context chains over 256KB total.

Guarded tools: `read`, `edit`, `write`, `grep`, `find`, `ls`.

The extension does not parse bash paths and does not provide add/remove commands.

## Command

`/obsidian` defaults to `/obsidian status`.

`/obsidian status` shows config state, active vault, loaded path count, full loaded path list, and warnings.
