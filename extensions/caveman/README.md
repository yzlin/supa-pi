# caveman

Standalone Pi extension for `/caveman` mode.

## Presentation scope

Caveman mode changes response presentation, not task authority or execution semantics. It keeps the terse caveman voice while preserving exact technical text and all higher-priority instructions. The canonical prompt also favors action-first user procedures, bounded numbered steps, useful current-state and next-step updates, scannable complete findings, concrete unblock requests, and factual separation of failures, suspected causes, and verified fixes.

These are prompt-level presentation instructions. Automated tests verify the canonical text and its transport through the agent-start hook and RPC; they do not evaluate model adherence.

## Attribution

- The caveman voice was inspired by Matt Pocock's [caveman skill](https://github.com/mattpocock/skills/blob/main/caveman/SKILL.md), available under the MIT License.
- The presentation refinements paraphrase selected action, progress, focus, and error-reporting ideas from Ayoub Ghriss's [i-have-adhd skill](https://github.com/ayghri/i-have-adhd/blob/main/skills/i-have-adhd/SKILL.md), available under the MIT License. They do not import its medical framing, mandatory estimates, hard list caps, or every-turn narration, and do not alter Caveman commands, state, or RPC.

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

### Event-bus RPC v1

Caveman owns the canonical prompt text and exposes prompt transformation over Pi's shared event bus.

- Capabilities channel: `caveman:rpc:capabilities`
  - Response: `{ "success": true, "data": { "version": 1, "supportsApply": true } }`
- Apply channel: `caveman:rpc:apply`
  - Request: `{ "requestId": "...", "version": 1, "enabled": true, "systemPrompt": "..." }`
  - Success response: `{ "success": true, "data": { "version": 1, "systemPrompt": "..." } }`
  - Error response: `{ "success": false, "error": "..." }`

Replies go to `replyTo` when provided. Otherwise, requests with `requestId` emit to `<channel>:response:<requestId>`, falling back to `<channel>:response`.

Prompt behavior:

- `enabled: true` strips inherited canonical caveman text, then appends it exactly once.
- `enabled: false` strips inherited canonical caveman text.

### Runtime behavior

When active, caveman appends a system-prompt instruction before agent start and publishes generic extension status key `caveman` with value `🪨 caveman`. Status UIs can display the active mode through Pi's generic extension status channel. `pieditor` also has a dedicated `caveman` status-bar segment that reads the same status key when this extension is loaded.

Child processes can override config/session state with `--caveman` or `--no-caveman`. Herdr-backed subagent launches rely on these child-native flags; real Herdr end-to-end validation is intentionally out of scope for this extension's normal tests.
