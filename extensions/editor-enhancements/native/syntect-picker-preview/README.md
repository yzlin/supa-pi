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
- Native preview syntax + theme resolution uses bat's embedded compiled assets via `bat::assets::HighlightingAssets::from_binary()`, instead of loading the vendored `.tmTheme` files directly.
- Native preview colors use bat's built-in `Monokai Extended` for dark mode and `Monokai Extended Light` for light mode.
- Output matches bat's built-in compiled assets for those theme names; user-local bat config/theme overrides are not applied here.
- Native ANSI output is foreground-only, so the picker keeps its own pane background instead of painting bat-style token backgrounds behind text.
- Windows is not wired in this first pass.
