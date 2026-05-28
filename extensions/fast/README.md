# fast

Fast Mode is an active extension registered from `package.json -> pi.extensions`.

## Usage

- Start Pi with `--fast` to enable Fast Mode for the runtime.
- Use `/fast on` to enable Fast Mode and persist it.
- Use `/fast off` to disable Fast Mode and persist it.
- Use `/fast status` to refresh and report the current state.
- Use bare `/fast` to toggle Fast Mode and persist it.

When Fast Mode is enabled, the extension sets generic status key `fast` to `⚡ fast` for supported models and `⚡ fast*` for unsupported models. The `pieditor` status bar renders that status beside the `model` segment as compact `⚡` or `⚡*`, without duplicating it in `extension_statuses` when `model` is configured.

Command notifications use the model support source: `model`, `built-in allowlist`, `config allowlist`, or `unsupported`. For example, `/fast status` can report `Fast mode enabled (current model: config allowlist)`.

## Persistence and config

`/fast on`, `/fast off`, and bare `/fast` write both:

- a session custom entry with custom type `fast:mode`
- global config at `~/.pi/agent/fast-mode.json`

`~/.pi/agent/fast-mode.json` uses this schema:

```json
{
  "enabled": true,
  "warned": true,
  "allowlist": ["openai-codex/gpt-5.5"]
}
```

Editor schema help ships at `extensions/fast/configuration_schema.json`. It is tooling only; runtime reads the file directly. For example, in this repo a project-local `.pi/fast-mode.json` can start with:

```json
{
  "$schema": "../extensions/fast/configuration_schema.json",
  "enabled": true,
  "warned": true,
  "allowlist": ["openai-codex/gpt-5.5"]
}
```

- `enabled` is required and must be a boolean.
- `warned` is optional; non-boolean values are treated as `false`.
- `allowlist` is required and must be an array of exact canonical `provider/id` strings. Entries with whitespace, missing provider, or missing id are invalid.
- `allowList` is intentionally invalid; use lowercase `allowlist`.

Config allowlist entries add model support. A model supports Fast Mode when its metadata has `fastMode: true`, it matches the built-in allowlist (`openai-codex/gpt-5.5`), or it matches an exact `provider/id` entry from the config allowlist. The config allowlist does not replace built-in support.

Invalid config fails fast. Malformed JSON, non-object config, missing/non-boolean `enabled`, missing/non-array `allowlist`, invalid allowlist entries, or the deprecated `allowList` key throw during config read instead of silently falling back.

When writing state, the extension preserves existing unknown top-level config keys and preserves the existing `allowlist`. If no config file exists, the first write creates one with the built-in allowlist.

On session start, session switch, or session tree navigation, state resolves in this order:

1. `--fast`, when present
2. latest valid `fast:mode` session entry
3. global `~/.pi/agent/fast-mode.json`
4. disabled default

`--fast` also writes the enabled state through the normal persistence path after session state refresh.

There is no live reload or file watcher. Config is read when runtime state is refreshed from the normal session lifecycle, and writes re-read the file before preserving config fields.

## Provider behavior

Fast Mode only patches provider payloads when all of these are true:

- Fast Mode is enabled
- the selected model supports Fast Mode through metadata or allowlist matching
- the provider payload is an object
- the payload does not already contain `service_tier` or `serviceTier`

When those checks pass, the extension returns a patched payload with `service_tier: "priority"` from the `before_provider_request` hook.

## Limitations

- Fast Mode depends on model metadata having `fastMode: true` or the selected model matching the built-in/config allowlist; it does not add upstream model parser support.
- Unsupported models can still show Fast Mode enabled, but provider payloads are not patched for them.
- Existing provider `service_tier` or `serviceTier` values are never overwritten.
- The extension warns once when `/fast on` is used because priority service tier may cost more.
