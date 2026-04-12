# pieditor architecture

read_when:
- refactoring `extensions/pieditor/index.ts`, `composition.ts`, or editor lifecycle wiring
- changing file-picker runtime/config behavior
- changing status-bar rendering, footer integration, or git invalidation
- adding another feature that wants to own `setEditorComponent()`

## Purpose

`pieditor` is a composite editor extension. It owns Pi's custom editor surface and layers several UX features behind one `setEditorComponent()` integration so they stay compatible.

Current feature areas:
- editor lifecycle + shortcut wiring
- `@` file picker
- `!` / `!!` shell completions
- top-border status bar
- raw clipboard paste via `alt+v`
- optional double-escape command trigger
- slash-command remapping at submit time

## Ownership boundaries

### `index.ts`
Thin extension entrypoint.
Owns:
- Pi event registration
- shortcut registration
- delegation into composition runtime

### `composition.ts`
Runtime wiring boundary.
Owns:
- active context/editor/footer refs
- attaching `EnhancedEditor`
- footer hookup
- preview highlighter warmup
- git invalidation triggers from tool/user bash events

### `editor/*`
Editor behavior only.
Owns:
- submit interception and command remap
- double-escape timing/decision logic
- autocomplete wrapping
- status-bar insertion above the native editor border

### `file-picker/*`
Picker-specific UI and data flow.
Owns:
- file listing/filtering/preview/highlighting
- picker-local state and option toggles
- converting selections into `@path` refs

`file-picker/runtime.ts` creates the picker runtime explicitly. This preserves current effective behavior while avoiding import-time config/state initialization.

### `status-bar/*`
Status bar rendering.
Owns:
- context collection
- preset resolution
- segment rendering
- git status helpers
- icon/theme helpers

### `shell/*`
Shell completion providers and shell detection.

## Event sources

- `session_start`
  - attach custom editor
  - attach footer listener
  - warm preview highlighting
- `tool_result`
  - invalidate git status after `write` / `edit`
  - invalidate git branch/state after branch-changing `bash` commands
- `user_bash`
  - invalidate git branch/state after branch-changing commands
- `alt+v`
  - paste raw clipboard text into the editor

## Config layering

Primary config files:
- global: `~/.pi/agent/pieditor.json`
- project: `.pi/pieditor.json`

Merge order:
1. built-in defaults
2. global config
3. project config

Notes:
- `commandRemap` merges by key
- file-picker config merges by field; `skipPatterns` is replaced by the last layer that sets it
- status-bar config merges by field; colors and nested segment options merge by semantic key / nested field

## Native preview fallback

Preview highlighting prefers the local Rust/N-API addon when configured for `native` mode.
Fallback order:
1. native addon
2. Pi built-in highlighting
3. plain preview text when highlighting is unavailable

Native highlighting is picker-preview-only. It does not change the rest of the editor.

## Compatibility rule

`pieditor` intentionally owns `setEditorComponent()`.
Do not enable other extensions that also replace the editor component at the same time unless they are merged into `pieditor` first.
