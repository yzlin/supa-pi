# caveman

Standalone Pi extension for `/caveman` mode.

## Attribution

Inspired by Matt Pocock's caveman skill:
- https://github.com/mattpocock/skills/blob/main/caveman/SKILL.md

## Public contract

### Commands

- `/caveman` — toggle caveman mode for the current session
- `/caveman toggle` — toggle caveman mode for the current session
- `/caveman on` — enable caveman mode for the current session
- `/caveman off` — disable caveman mode for the current session
- `/caveman status` — show the current mode state

Command changes are persisted as session entries with custom type `caveman:mode`. Existing legacy `pieditor:caveman-mode` session entries are still read as a fallback.

### Config files

Caveman reads optional JSON config from:

1. project `.pi/caveman.json`
2. global `~/.pi/agent/caveman.json`
3. built-in default `{ "enabled": false }`

Project config wins over global config. Latest valid session state wins over both config files. Invalid or malformed config files are ignored.

Config-derived state is runtime-only: loading config does not append `caveman:mode` session entries. Use `/caveman on`, `/caveman off`, or `/caveman toggle` to persist a session override.

Example `.pi/caveman.json` or `~/.pi/agent/caveman.json`:

```json
{
  "enabled": true
}
```

Editor schema help ships at `extensions/caveman/configuration_schema.json`. It is tooling only; runtime reads only the `enabled` boolean. For example, in this repo a project-local `.pi/caveman.json` can start with:

```json
{
  "$schema": "../extensions/caveman/configuration_schema.json",
  "enabled": true
}
```

### Runtime behavior

When active, caveman appends a system-prompt instruction before agent start and publishes generic extension status key `caveman` with value `🪨 caveman`. Status UIs can display the active mode through Pi's generic extension status channel. `pieditor` also has a dedicated `caveman` status-bar segment that reads the same status key when this extension is loaded.
