# whimsical

Whimsical is an active folder extension registered from `package.json -> pi.extensions` as `./extensions/whimsical`.

It sets a random working message on `turn_start` and clears it on `turn_end`.

## Usage

- `/whimsical` shows the current selected message set and available bundled plus valid custom sets.
- `/whimsical default` selects the default message set.
- `/whimsical negative-energy` selects the negative-energy message set.
- `/whimsical <custom-slug>` selects a valid custom message set.

Command arguments support completions for bundled and valid custom set names. Unknown names are rejected with usage help.

## Bundled sets

Message sets live in `extensions/whimsical/messages/`:

- `default.json` — the standard whimsical message pool.
- `negative-energy.json` — a darker alternate message pool.

Each bundled set is a non-empty JSON array of non-whitespace strings:

```json
[
  "Consulting the rubber duck...",
  "Reticulating splines..."
]
```

Invalid bundled JSON or invalid message arrays fail during extension load.

## Custom sets

Users can add custom message sets in the live Pi config directory:

```text
~/.pi/agent/whimsical/<slug>.json
```

Custom filenames must use lowercase slugs with only `a-z`, `0-9`, `_`, and `-`, plus the `.json` extension. Each file must contain a non-empty JSON array of non-whitespace strings.

Custom sets are scanned on extension init/session lifecycle and command invocation. Command completions use the cached list from the last scan. There is no live reload or file watcher. Valid custom sets appear after bundled sets in alphabetical order, with duplicates removed. If a valid custom set uses the same name as a bundled set, it shadows that bundled set when selected. Fallback to `default` always uses the bundled default, even if a custom `default.json` is invalid.

Invalid unselected custom files are ignored quietly. If an invalid custom set is selected by session/config state or command, whimsical warns with the set name and validation reason only, then uses bundled `default`. If `~/.pi/agent/whimsical/` exists but is not a readable directory, whimsical warns once and ignores custom sets.

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

If persisted state requests a set that is no longer available, whimsical falls back to bundled `default` and warns once per runtime. Malformed config JSON or a config object without a non-empty string `selectedSet` fails fast during config read.

## Out of scope

Whimsical does not watch custom files for live reload. Changes are picked up on extension init/session lifecycle and command invocation.
