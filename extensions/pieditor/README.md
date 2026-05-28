# pieditor

A composite custom editor that combines several `setEditorComponent()`-based UX tweaks in one place so they remain compatible with each other.

## Attribution

This repo maintains its own rewritten and independently evolving variant of the upstream `editor-enhancements` extension, under the local name `pieditor`.
The original extension concept and initial implementation came from `w-winter/dot314`:
- https://github.com/w-winter/dot314/tree/main/extensions/editor-enhancements

Please keep that upstream credit in place when updating this local version. This repo may continue evolving the extension in its own direction, but the original author should remain credited for the upstream design and starting point.

File picker preview highlighting is also powered by:
- `bat`: https://github.com/sharkdp/bat
- `syntect`: https://github.com/trishume/syntect/

This extension currently provides:
- powerline-style status bar rendered in the editor's top border
- `@`-triggered file picking for inserting `@path` refs at the cursor
- shell completions in `!` / `!!` mode
- `alt+v` raw clipboard paste that bypasses Pi's large-paste markers
- optional remapping of the editor's empty-editor double-escape gesture to an extension command such as `/anycopy`
- configurable command remapping (e.g. make `/tree` execute `/anycopy` instead)
- dedicated `caveman` status-bar segment that displays the standalone caveman extension's generic `caveman` status when active

## Usage

This extension mostly integrates directly into the editor, with one runtime toggle command surface.

Notable interactions:
- Type `@` at token start to open the file picker
- In the file picker, `space` queues or unqueues the highlighted file, or enters the highlighted directory
- In the file picker, `ctrl+n` / `ctrl+p` move the highlight down / up in the file list and options panel
- In the file picker, `enter` inserts the highlighted item plus any queued selections, while `esc` at the root inserts only queued selections
- The picker opens as a near-full-height overlay, keeps the Files panel at a fixed height, and renders an internal preview pane below it that fills the remaining height for the highlighted file or directory
- File previews in the preview pane can use either the picker-local syntect native addon (`previewHighlightMode: "native"`) or Pi's built-in syntax highlighting (`previewHighlightMode: "builtin"`)
- The file picker's search includes files inside symlinked directories, including when `respectGitignore` is enabled for a git repo
- The file picker's search box uses Pi's shared `Input` editing behavior for word/home/end cursor movement and related text editing shortcuts
- Press `alt+v` to paste clipboard text raw into the editor
- If the standalone `extensions/caveman` extension is loaded, built-in presets show the active `🪨 caveman` indicator through the dedicated `caveman` segment; custom segment lists must include `caveman` or `extension_statuses` to show it.
- If the standalone `extensions/fast` extension is loaded, status key `fast` is appended to the `model` segment as compact `⚡` or `⚡*` without a dot separator. `extension_statuses` suppresses `fast` when `model` is configured.
- Optionally configure `doubleEscapeCommand` in `~/.pi/agent/pieditor.json` or `.pi/pieditor.json` to invoke an extension command on double-escape when the editor is empty and Pi is idle
- Optionally configure `commandRemap` in `~/.pi/agent/pieditor.json` or `.pi/pieditor.json` to redirect slash commands at submit time (e.g. typing `/tree` executes `/anycopy` instead)
- Use `/pieditor fixed-editor [on|off|toggle|status]` to toggle fixed editor mode for the live runtime and persist the global `fixedEditor.enabled` setting; project `.pi/pieditor.json` overrides still win on the next load
- Fixed editor mode reserves the root scrollback viewport's rightmost column for a visual-only scrollbar: dim gray `█` track, bright white `█` thumb; it has no configuration and stays out of overlay rendering
- When a user message starts or a follow-up queue update arrives, fixed editor mode jumps the root scrollback back to the bottom; manual root scrollback remains available between sends
- Internal local extensions that temporarily replace the editor/custom UI surface can acquire a replacement-surface lease so fixed editor mode stands down while the replacement UI is active

## Configuration

This extension primarily reads two config files:

1. `~/.pi/agent/pieditor.json` for global defaults
2. `.pi/pieditor.json` for project overrides

Put file picker settings under the nested `filePicker` key in either file (copy from `config.json.example`).

Editor schema help: this extension now ships `extensions/pieditor/configuration_schema.json`. I found no pi-side auto-discovery for that filename in this repo or the installed pi package, so use it as editor tooling only: either associate your config file with that schema in editor settings, or add a `$schema` path manually when your config location makes a stable relative path possible.

For example, in this repo a project-local `.pi/pieditor.json` can point at:

```json
{
  "$schema": "../extensions/pieditor/configuration_schema.json"
}
```

Then add the rest of your config fields:

- `doubleEscapeCommand`: optional extension command name to invoke on double-escape
  - default: `null`
  - accepts either `"anycopy"` or `"/anycopy"`
  - only commands registered via `pi.registerCommand()` are supported
  - Pi native built-ins like `/tree` are not supported here
- `commandRemap`: map of command names to replacements, applied at submit time
  - default: `{}`
  - keys and values are normalized (leading `/` stripped, whitespace trimmed)
  - works for all command types: built-in (`/tree`, `/model`), extension, skill, and template commands
  - arguments and subcommand syntax (everything after the command name) are preserved
- `fixedEditor`: nested fixed editor config; disabled by default and only active after explicit opt-in
  - `enabled`: default `false`; opt in to fixed editor mode
  - `mouseScroll`: default `true`; allow mouse wheel scrolling in fixed editor mode
  - `scrollUpShortcuts`: default `["super+up"]`; shortcut or shortcuts for scrolling the fixed editor viewport up
  - `scrollDownShortcuts`: default `["super+down"]`; shortcut or shortcuts for scrolling the fixed editor viewport down
  - `/pieditor fixed-editor [on|off|toggle|status]` updates the live runtime and saves `enabled` in the global config; if project `.pi/pieditor.json` sets `fixedEditor.enabled`, that project override wins after the next load and `status` marks it as active
- `filePicker`: nested file picker config
  - `respectGitignore`: default `true`
  - `skipHidden`: default `true`
  - `allowFolderSelection`: default `true`; when enabled, folders can be queued/attached as `@path/` refs while `→` still opens them for navigation; when disabled, folders stay visible for navigation and render with a nav marker instead of a checkbox
  - `skipPatterns`: default `["node_modules"]`
  - `tabCompletionMode`: `"segment"` or `"bestMatch"` (default `"bestMatch"`)
    - `"segment"`: prefix-only candidate matching, then complete one word-part at a time
    - `"bestMatch"`: use the strongest scoped fuzzy match and replace the whole query in one Tab
  - `previewHighlightMode`: `"native"` or `"builtin"` (default `"native"`)
    - `"native"`: use the picker-local Rust/syntect highlighter backed by bat's embedded compiled assets, with Pi built-in highlighting as runtime fallback if the native binary is unavailable
    - `"builtin"`: always use Pi's built-in JS highlighter and skip native warmup/load work
- `editorChrome`: nested editor chrome config
  - `style`: `classic` or `amp` (default `classic`); `classic` preserves the existing editor chrome. `amp` uses rounded Amp-style editor borders in normal and fixed-editor mode, keeps status-bar `leftSegments` and `rightSegments` split across the top border with border-line fill between them, moves configured `path`/`git` status segments to the right-aligned bottom border, keeps an empty Amp frame when `statusBar.enabled` is `false`, and falls back to classic editor lines in very narrow terminals. It does not add Amp non-editor UI, color config, or other Amp features.
- `statusBar`: nested status-bar config
  - `enabled`: default `true`
  - `preset`: one of `default`, `minimal`, `compact`, `full`, `nerd`, `ascii`; default `default`
  - `leftSegments`: optional ordered list of segment ids for the left side; when omitted, inherits the preset default
  - `rightSegments`: optional ordered list of segment ids for the right side; when omitted, inherits the preset default
  - `separator`: optional literal separator text inserted between visible segments; when omitted, inherits the preset separator; may be empty (`""`)
  - `colors`: optional semantic color overrides layered on top of the preset palette
    - supported color keys: `pi`, `model`, `path`, `gitDirty`, `gitClean`, `thinking`, `context`, `contextWarn`, `contextError`, `cost`, `tokens`, `separator`
    - values may be Pi theme color names or `#RRGGBB` hex
  - `segmentOptions`: optional per-segment overrides layered on top of the preset defaults
    - `model.showThinkingLevel`: boolean
    - `path.mode`: `basename`, `abbreviated`, or `full`
    - `path.maxLength`: positive integer, used with `abbreviated`
    - `git.showBranch`, `git.showStaged`, `git.showUnstaged`, `git.showUntracked`: booleans
    - `time.format`: `12h` or `24h`
    - `time.showSeconds`: boolean
  - icon mode: Nerd Font icons are on by default; set `POWERLINE_NERD_FONTS=0` before launching Pi to force ASCII fallbacks
  - supported segment ids: `pi`, `model`, `path`, `git`, `token_in`, `token_out`, `token_total`, `cost`, `context_pct`, `context_total`, `time_spent`, `time`, `session`, `hostname`, `cache_read`, `cache_write`, `thinking`, `caveman`, `extension_statuses`
  - `caveman` renders the generic extension status key `caveman`; `extension_statuses` suppresses that key when the dedicated `caveman` segment is configured
  - `model` appends Fast Mode's generic extension status key `fast` as compact `⚡` or `⚡*` without a dot separator; `extension_statuses` suppresses `fast` when `model` is configured

```json
{
  "doubleEscapeCommand": "anycopy",
  "commandRemap": {
    "tree": "anycopy",
    "resume": "switch-session"
  },
  "editorChrome": {
    "style": "classic"
  },
  "fixedEditor": {
    "enabled": false,
    "mouseScroll": true,
    "scrollUpShortcuts": ["super+up"],
    "scrollDownShortcuts": ["super+down"]
  },
  "filePicker": {
    "respectGitignore": true,
    "skipHidden": true,
    "allowFolderSelection": true,
    "skipPatterns": ["node_modules"],
    "tabCompletionMode": "bestMatch",
    "previewHighlightMode": "native"
  },
  "statusBar": {
    "enabled": true,
    "preset": "default",
    "leftSegments": ["pi", "model", "caveman", "path", "git"],
    "rightSegments": ["context_pct", "extension_statuses"],
    "separator": " | ",
    "colors": {
      "model": "success",
      "separator": "muted",
      "context": "#89d281"
    },
    "segmentOptions": {
      "model": {
        "showThinkingLevel": true
      },
      "path": {
        "mode": "abbreviated",
        "maxLength": 32
      },
      "git": {
        "showUntracked": false
      }
    }
  }
}
```

Status bar presets are borrowed from `pi-powerline-footer`, but this extension ports only the bar itself — no stash UI, welcome overlay, or working vibes.

Set `doubleEscapeCommand` to `null` to disable the remapping and keep Pi's native double-escape behavior. Set `commandRemap` to `{}` (or omit it) to disable command remapping.

Runtime merge order for pieditor config is:
1. built-in defaults
2. global `~/.pi/agent/pieditor.json`
3. project `.pi/pieditor.json`

`commandRemap` maps are merged by key. `editorChrome`, `fixedEditor`, `filePicker`, and `statusBar` values are merged by field, with later layers winning; invalid `editorChrome.style` values are ignored so lower layers/defaults still apply. `fixedEditor` shortcut arrays and `filePicker.skipPatterns` come from the last layer that sets them. `statusBar.leftSegments` and `statusBar.rightSegments` are each replaced by the last layer that sets them, `separator` takes the last configured literal string, `colors` merge by semantic key, and `segmentOptions` merge per nested field.

Config layout:

```text
project-root/
├── .pi/
│   └── pieditor.json
└── …

~/.pi/agent/
└── pieditor.json
```

## Internal replacement-surface lease API

`extensions/pieditor/fixed-editor/replacement-lease.ts` exposes a local, internal coordination API for extensions that temporarily replace the editor surface, such as `ctx.ui.custom` flows. Use it only from trusted in-repo extensions; it is not a public Pi extension API.

Typical usage:

```ts
await withReplacementSurfaceLease(
  {
    owner: "questionnaire",
    id: "custom-ui",
    target: QUESTIONNAIRE_REPLACEMENT_SURFACE,
  },
  async () => ctx.ui.custom(component)
);
```

API surface:

- `acquireReplacementSurfaceLease({ owner, id, target })`: acquires a lease and returns `{ owner, id, release() }`. `release()` is idempotent.
- `withReplacementSurfaceLease(options, run)`: async helper that always releases in `finally`, including thrown UI errors or cancellation paths.
- `getActiveReplacementLeaseDiagnostics()`: returns active `{ owner, id }` entries for status reporting and tests.
- `clearReplacementSurfaceLeases()`: clears all active leases during editor/session teardown.
- `attachReplacementLeaseCompositor(compositor | null)`: composition hook used by fixed editor mode; callers should not use it directly.

Behavior while leased:

- Multiple leases are additive. A target is unhidden only after its last lease releases.
- If fixed editor mode is active, the leased target is hidden from the fixed-editor compositor and the terminal is repainted.
- If no compositor is attached, lease acquisition is a no-op for rendering but diagnostics still track the active lease.
- If a compositor attaches after a lease exists, it immediately hides all currently leased targets.
- While any replacement lease is active, the terminal split compositor remains installed but bypasses fixed-editor reservation/repaint, root scrollbar decoration, and fixed-editor scroll/mouse/selection handling so the replacement UI owns the surface.
- Editor detach/session shutdown clears all leases and detaches the compositor.

Diagnostics:

- `/pieditor fixed-editor status` includes `replacement leases: 0` when none are active.
- While leases are active, status reports the count and owners, for example `replacement leases: 1 (questionnaire)`.

## Native preview addon

The file picker can use a local Rust/N-API addon at `extensions/pieditor/native/syntect-picker-preview/` for richer preview highlighting.

Build it from the repo root:

```bash
npm run build:syntect-picker-preview
```

Current scope:
- picker preview only
- macOS + Linux on `x64` / `arm64`
- optional at runtime when `previewHighlightMode` is `"native"`; if the native binary is absent or fails to load, preview highlighting falls back to Pi's current JS highlighter
- preview highlighting is powered by `bat` (https://github.com/sharkdp/bat) and `syntect` (https://github.com/trishume/syntect/)
- syntax + theme resolution comes from bat's embedded compiled assets, not direct loading of the vendored `.tmTheme` files
- native preview colors use bat's built-in `Monokai Extended` for dark mode and `Monokai Extended Light` for light mode
- preview gutter line numbers and the adjacent divider follow bat's gutter foreground/divider colors even when syntax highlighting falls back or the file type is unrecognized
- output matches bat's built-in compiled assets for those theme names; user-local bat config/theme overrides are not applied here

## Maintainer docs

- [`docs/architecture.md`](./docs/architecture.md)

## Notes

- The configured double-escape command is only triggered when the editor is empty and Pi is idle
- If the configured command is not a registered extension command, the extension warns and falls back to native behavior
- Command remapping intercepts at the editor submission layer via `onSubmit`, so it applies uniformly to all submit paths (Enter, double-escape gesture, etc.) and works with any command type — built-in, extension, skill, or template. If a remap target doesn't exist as a registered command, pi treats it as a regular prompt
- Because this extension owns `setEditorComponent()`, disable standalone editor-replacement extensions such as `shell-completions/`, `file-picker.ts`, and `raw-paste.ts` to avoid conflicts
- Fixed editor mode conflicts with `pi-powerline-footer`'s fixed editor mode; enable only one fixed editor compositor at a time

## Manual validation notes

- Start Pi without `fixedEditor.enabled` and confirm the native editor remains unchanged
- Run `/pieditor fixed-editor on`, `/pieditor fixed-editor off`, `/pieditor fixed-editor toggle`, and `/pieditor fixed-editor status`; confirm notifications, live behavior, and global `~/.pi/agent/pieditor.json` persistence
- With fixed editor enabled, confirm mouse wheel scrolling follows `mouseScroll` and configured scroll shortcuts move the fixed editor viewport
- Add project `.pi/pieditor.json` with `fixedEditor.enabled` set opposite the global value, restart/reload Pi, and confirm the project value wins; `status` should report the project override
