# syntect-picker-preview

Local picker-only native addon for `extensions/editor-enhancements`.

## Scope

- File picker preview highlighting only
- macOS + Linux first
- Optional at runtime: if no built `.node` binary is present, the picker falls back to Pi's current JS highlighting path

## Build

From repo root:

```bash
npm run build:syntect-picker-preview
```

Or from this package directory:

```bash
node ./scripts/build.mjs
```

## Notes

- The generated `.node` binaries are intentionally local build artifacts and are ignored by git.
- Native preview colors use bat's bundled default themes: `Monokai Extended` for dark mode and `Monokai Extended Light` for light mode.
- Native ANSI output is foreground-only, so the picker keeps its own pane background instead of painting bat-style token backgrounds behind text.
- `.ts` / `.tsx` use syntect's built-in JavaScript grammar as the closest default approximation; the bundled syntect dump does not include native TypeScript grammars.
- The bat theme assets are vendored locally under `themes/` with the upstream Monokai Extended license included.
- Windows is not wired in this first pass.
