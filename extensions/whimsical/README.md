# whimsical

Whimsical is an active folder extension registered from `package.json -> pi.extensions` as `./extensions/whimsical`.

It sets a random working message on `turn_start` and clears it on `turn_end`.

## Usage

- `/whimsical` shows the current selected message set and available bundled sets.
- `/whimsical default` selects the default message set.
- `/whimsical negative-energy` selects the negative-energy message set.

Command arguments support completions for bundled set names. Unknown names are rejected with usage help.

## Bundled sets

Message sets live in `extensions/whimsical/messages/`:

- `default.json` — the standard whimsical message pool.
- `negative-energy.json` — a darker alternate message pool.

Each bundled set is a non-empty JSON array of non-empty strings:

```json
[
  "Consulting the rubber duck...",
  "Reticulating splines..."
]
```

Invalid bundled JSON or invalid message arrays fail during extension load.

## Persistence and precedence

`/whimsical <set>` writes both:

- a session custom entry with custom type `whimsical:set`
- global config at `~/.pi/agent/whimsical.json`

The config shape is:

```json
{
  "selectedSet": "default"
}
```

Editor schema help ships at `extensions/whimsical/configuration_schema.json`. It is tooling only; runtime reads `~/.pi/agent/whimsical.json` directly.

On session start or session tree navigation, state resolves in this order:

1. latest valid `whimsical:set` session entry
2. global `~/.pi/agent/whimsical.json`
3. `default`

Command state wins over config so a session can keep its selected set even if the global config later changes.

There is no live reload or file watcher. Config is read when runtime state is refreshed from the normal session lifecycle.

## Fallback behavior

If persisted state requests a set that is no longer bundled, whimsical falls back to `default` and warns once per runtime. Malformed config JSON or a config object without a non-empty string `selectedSet` fails fast during config read.

## Out of scope

Users cannot add arbitrary message-set files through config. Only bundled sets listed by the extension are selectable. Adding new sets requires a code change that updates the bundled JSON file list, command completions, schema enum, and docs.
