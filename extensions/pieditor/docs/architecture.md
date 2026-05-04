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
- opt-in fixed editor runtime/config command surface

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
- fixed editor compositor lifecycle when `fixedEditor.enabled` is true

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

### `fixed-editor/*`

Fixed editor rendering/compositor helpers only.
Owns:
- fixed editor cluster rendering primitives
- terminal split compositor primitives
- root scrollback visual scrollbar decoration: one rightmost-column gutter, dim gray `█` track, bright white `█` thumb

Runtime lifecycle installation and send-triggered root scrollback bottom jumps are owned by `composition.ts` when that integration is enabled.

### `status-bar/*`
Status bar rendering.
Owns:
- context collection
- preset resolution
- segment rendering
- git status helpers
- icon/theme helpers

The dedicated `caveman` segment is an integration point for the standalone `extensions/caveman` extension. It reads the generic extension status key `caveman` from footer data instead of importing caveman state directly.

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
- `message_start`
  - jump fixed-editor root scrollback to bottom when a user message starts
- `input`
  - jump fixed-editor root scrollback to bottom for busy interactive input before Pi queues the follow-up
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
- fixed-editor config merges by field; shortcut arrays are replaced by the last layer that sets them
- status-bar config merges by field; colors and nested segment options merge by semantic key / nested field

Fixed editor is opt-in: `fixedEditor.enabled` defaults to `false`. `/pieditor fixed-editor [on|off|toggle|status]` updates the live runtime and persists only the global `fixedEditor.enabled` value. If project `.pi/pieditor.json` defines `fixedEditor.enabled`, it still wins on the next load; the command warns after saving global state and `status` reports the active project override.

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

Fixed editor mode also owns terminal split composition. Do not enable it alongside `pi-powerline-footer`'s fixed editor mode; both install fixed editor compositors and will conflict.

## Manual validation notes

- Boot with default config and confirm fixed editor mode is off
- Use `/pieditor fixed-editor on|off|toggle|status` and confirm live runtime state plus global config persistence
- Verify mouse wheel and configured shortcut scrolling while fixed editor mode is enabled
- Confirm fixed editor root scrollback shows the one-column visual scrollbar and returns to bottom on user-message start or follow-up queue update
- Add a project `fixedEditor.enabled` override and confirm it wins over global config on reload
