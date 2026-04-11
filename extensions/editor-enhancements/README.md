# editor-enhancements

A composite custom editor that combines several `setEditorComponent()`-based UX tweaks in one place so they remain compatible with each other.

## Attribution

This repo maintains its own rewritten local variant of `editor-enhancements`.
The original extension concept and initial implementation came from `w-winter/dot314`:
- https://github.com/w-winter/dot314/tree/main/extensions/editor-enhancements

Credit to the original author for the upstream extension and overall design direction.

This extension currently provides:
- `@`-triggered file picking for inserting `@path` refs at the cursor
- shell completions in `!` / `!!` mode
- `alt+v` raw clipboard paste that bypasses Pi's large-paste markers
- optional remapping of the editor's empty-editor double-escape gesture to an extension command such as `/anycopy`
- configurable command remapping (e.g. make `/tree` execute `/anycopy` instead)

## Usage

This extension does not add a primary top-level slash command of its own. Its behavior is integrated directly into the editor.

Notable interactions:
- Type `@` at token start to open the file picker
- In the file picker, `space` queues or unqueues the highlighted file, or enters the highlighted directory
- In the file picker, `ctrl+n` / `ctrl+p` move the highlight down / up in the file list and options panel
- In the file picker, `enter` inserts the highlighted item plus any queued selections, while `esc` at the root inserts only queued selections
- The picker opens as a near-full-height overlay, keeps the Files panel at a fixed height, and renders an internal preview pane below it that fills the remaining height for the highlighted file or directory
- File previews in the preview pane can use either the picker-local syntect native addon (`previewHighlightMode: "native"`) or Pi's built-in syntax highlighting (`previewHighlightMode: "builtin"`)
- The file picker's search box uses Pi's shared `Input` editing behavior for word/home/end cursor movement and related text editing shortcuts
- Press `alt+v` to paste clipboard text raw into the editor
- Optionally configure `doubleEscapeCommand` in `~/.pi/agent/editor-enhancements.json` or `.pi/editor-enhancements.json` to invoke an extension command on double-escape when the editor is empty and Pi is idle
- Optionally configure `commandRemap` in `~/.pi/agent/editor-enhancements.json` or `.pi/editor-enhancements.json` to redirect slash commands at submit time (e.g. typing `/tree` executes `/anycopy` instead)

## Configuration

This extension primarily reads two config files:

1. `~/.pi/agent/editor-enhancements.json` for global defaults
2. `.pi/editor-enhancements.json` for project overrides

Put file picker settings under the nested `filePicker` key in either file (copy from `config.json.example`):

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
- `filePicker`: nested file picker config
  - `respectGitignore`: default `true`
  - `skipHidden`: default `true`
  - `allowFolderSelection`: default `true`; when enabled, folders can be queued/attached as `@path/` refs while `→` still opens them for navigation; when disabled, folders stay visible for navigation and render with a nav marker instead of a checkbox
  - `skipPatterns`: default `["node_modules"]`
  - `tabCompletionMode`: `"segment"` or `"bestMatch"` (default `"bestMatch"`)
    - `"segment"`: prefix-only candidate matching, then complete one word-part at a time
    - `"bestMatch"`: use the strongest scoped fuzzy match and replace the whole query in one Tab
  - `previewHighlightMode`: `"native"` or `"builtin"` (default `"native"`)
    - `"native"`: use the picker-local Rust/syntect/bat-backed highlighter, with Pi built-in highlighting as runtime fallback if the native binary is unavailable
    - `"builtin"`: always use Pi's built-in JS highlighter and skip native warmup/load work

```json
{
  "doubleEscapeCommand": "anycopy",
  "commandRemap": {
    "tree": "anycopy",
    "resume": "switch-session"
  },
  "filePicker": {
    "respectGitignore": true,
    "skipHidden": true,
    "allowFolderSelection": true,
    "skipPatterns": ["node_modules"],
    "tabCompletionMode": "bestMatch",
    "previewHighlightMode": "native"
  }
}
```

Set `doubleEscapeCommand` to `null` to disable the remapping and keep Pi's native double-escape behavior. Set `commandRemap` to `{}` (or omit it) to disable command remapping.

Runtime merge order for file picker config is:
1. built-in defaults
2. legacy `~/.pi/agent/extensions/editor-enhancements/file-picker.json` fallback, if present
3. global `~/.pi/agent/editor-enhancements.json`
4. project `.pi/editor-enhancements.json`

`commandRemap` maps are merged by key. `filePicker` values are merged by field, with later layers winning; `skipPatterns` comes from the last layer that sets it. New configs should use the nested `filePicker` key, but the legacy fallback file is still supported (see `file-picker.json.example`).

If you want all configs, they can coexist like this:

```text
project-root/
├── .pi/
│   └── editor-enhancements.json
└── …

~/.pi/agent/
├── editor-enhancements.json
└── extensions/
    └── editor-enhancements/
        └── file-picker.json  # legacy fallback only
```

## Native preview addon

The file picker can use a local Rust/N-API addon at `extensions/editor-enhancements/native/syntect-picker-preview/` for richer preview highlighting.

Build it from the repo root:

```bash
npm run build:syntect-picker-preview
```

Current scope:
- picker preview only
- macOS + Linux on `x64` / `arm64`
- optional at runtime when `previewHighlightMode` is `"native"`; if the native binary is absent or fails to load, preview highlighting falls back to Pi's current JS highlighter
- `.ts` / `.tsx` currently use syntect's built-in JavaScript grammar as an approximation because syntect's default dump does not ship native TypeScript grammars
- native preview colors use bat's default themes: `Monokai Extended` for dark mode and `Monokai Extended Light` for light mode

## Notes

- The configured double-escape command is only triggered when the editor is empty and Pi is idle
- If the configured command is not a registered extension command, the extension warns and falls back to native behavior
- Command remapping intercepts at the editor submission layer via `onSubmit`, so it applies uniformly to all submit paths (Enter, double-escape gesture, etc.) and works with any command type — built-in, extension, skill, or template. If a remap target doesn't exist as a registered command, pi treats it as a regular prompt
- Because this extension owns `setEditorComponent()`, disable standalone editor-replacement extensions such as `shell-completions/`, `file-picker.ts`, and `raw-paste.ts` to avoid conflicts
