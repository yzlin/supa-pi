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
- Adds loaded context as the `obsidian_context` system-prompt section at the start of each run, hidden from normal conversation history. Provider payload hooks are not used: `pi-claude-bridge` never runs them, and payload shapes differ per provider.
- Blocks guarded structured path tool calls when missing context is found. The block reason carries the new context files, so the model can follow them and retry the same tool call in the same run; later runs include them in the section.
- Blocks context files over 64KB and context chains over 256KB total.

Guarded tools: `read`, `edit`, `write`, `grep`, `find`, `ls`.

The extension does not parse bash paths and does not provide add/remove commands.

## Command

`/obsidian` defaults to `/obsidian status`.

`/obsidian status` shows config state, active vault, loaded path count, full loaded path list, and warnings.
