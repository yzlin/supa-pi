# tool-display

Local Pi extension for tool display ownership. It replaces the retired local `read-patch` extension.

## Config

Precedence:

1. defaults
2. global config: `~/.pi/agent/tool-display.json`
3. project config: `.pi/tool-display.json`

Later layers override earlier layers for scalar fields. `tools.read.fullRead.targets` are merged by `name`, so a global or project target can override one default target without copying every target.

Shape:

```json
{
  "tools": {
    "read": {
      "enabled": true,
      "fullRead": {
        "enabled": true,
        "order": ["skills", "user-rules", "project-rules", "docs"],
        "targets": [
          {
            "name": "docs",
            "enabled": true,
            "source": "patterns",
            "baseDir": "docs",
            "include": ["**/*.md"],
            "exclude": ["archive/**"],
            "maxBytes": 262144,
            "ignorePagination": true
          }
        ]
      }
    },
    "search": { "enabled": true },
    "edit": { "enabled": false, "allowPermanentDelete": false },
    "write": { "enabled": true }
  },
  "output": {
    "read": { "mode": "compact", "collapsed": true, "previewLines": 20 },
    "search": { "mode": "compact", "collapsed": true, "previewLines": 20 },
    "bash": {
      "enabled": true,
      "mode": "compact",
      "collapsed": true,
      "previewLines": 20,
      "rtkHints": true
    }
  },
  "diff": {
    "enabled": true,
    "collapsed": true,
    "previewLines": 80,
    "viewMode": "auto",
    "splitMinWidth": 120,
    "wordWrap": true,
    "indicatorMode": "bars"
  }
}
```

See `tool-display.example.json` for a project config example matching the default compact renderer setup.

Commands:

- `/tool-display show` displays the resolved config, including full-read target provenance and warnings.
- `/tool-display preset compact|verbose|off` writes `.pi/tool-display.json`.
- `/tool-display reset` writes default config to `.pi/tool-display.json`.

## Full-read targets

`tools.read.fullRead` is the full-read override for `read`. When enabled, matching targets can ignore requested pagination and return full file content up to a per-target byte cap. The per-target cap cannot exceed the hard 262144-byte safety cap.

Default full-read targets:

- `skills`: registered skill files, `source: "registeredSkills"`, `maxBytes: 262144`, `ignorePagination: true`
- `user-rules`: user rule markdown files, `source: "patterns"`, `maxBytes: 262144`, `ignorePagination: true`
- `project-rules`: project rule markdown files, `source: "patterns"`, `maxBytes: 262144`, `ignorePagination: true`

Target fields:

- `name`: required stable target name. Merge key and `/tool-display show` label.
- `enabled`: enables or disables this target. Default for new targets: `true`.
- `source`: `registeredSkills` or `patterns`. Default for new targets: `patterns`.
- `maxBytes`: positive integer cap applied to returned content. Default for new targets: `262144`; larger values are clamped to `262144` with a warning.
- `ignorePagination`: when `true`, matched reads ignore `offset` and `limit`. Default for new targets: `true`.
- `baseDir`: required for `patterns`. Relative values resolve from the project root; `~` resolves from the user home.
- `include`: required for `patterns`. Gitignore-style patterns matched under `baseDir`.
- `exclude`: optional Gitignore-style patterns matched under `baseDir` after `include`.

Merge behavior:

- Targets merge by `name` in this order: defaults, global config, project config.
- Re-declaring a target with the same `name` overrides only provided fields and keeps unspecified fields from the earlier layer.
- `fullRead.enabled` uses normal precedence: project, then global, then default.
- `order` is additive: global names first, then project names. Listed targets are tried first, once each, then all remaining targets keep insertion order.

Matching behavior and safety:

- Targets are tried in resolved order. The first enabled match wins.
- `registeredSkills` matches only canonical paths from the loaded skill registry.
- `patterns` resolves the requested file and `baseDir` to real paths, then matches only files contained inside `baseDir`.
- Project-config pattern targets are workspace-scoped: their real `baseDir` must stay inside the project root. Global-config pattern targets may point outside the project root.
- Full-read files are rejected before reading when their file size exceeds the hard 262144-byte safety cap, even when `ignorePagination` is `false`.
- Missing files, unreadable pattern bases, disabled targets, and non-matching targets are skipped.
- Invalid target entries are ignored during config normalization. Invalid target fields can add warnings, for example invalid `source`, missing `baseDir`, or missing `include`.
- `/tool-display show` prints target provenance (`default`, `global`, or `project`) and warnings so merged config is visible.

## Unified edit

The candidate local `edit` override defaults off while its live reliability gate is pending, so Pi's built-in `edit` remains available by default. Explicitly set `tools.edit.enabled` to `true` only to opt into evaluation or deliberate local use. When enabled, `edit` has a strict public `{ "text": "..." }` schema with no `reasoning` field. Its local dialect accepts either repeated `[path]` row sections (`@INS.PRE`, `@INS.POST`, `@INS.BEFORE`, `@INS.AFTER`, `@APPEND`, `@REPLACE`, and `@DEL`) or Codex-style `*** Begin Patch` payloads with Add/Update/Delete headers. It does not support moves and does not claim complete upstream compatibility. Pi's `prepareArguments` hook normalizes upstream-compatible raw strings and single `text`/`patch`/`input`/`content` aliases before strict validation. Retired classic, `multi`, and `edits` shapes are rejected; callers should produce `{ text }` directly.

`write` remains a separate, unchanged tool. Patch Add File is accepted only while `write` is enabled. Permanent Delete defaults off. Set `tools.edit.allowPermanentDelete` in global or project config to enable it (project scalar wins); each plan still requires one TUI/RPC confirmation showing the exact paths and complete planned diff. JSON/print modes reject deletes. Planning occurs before mutation, and source snapshots are rechecked under canonical path locks.

Pending expanded edit calls show an asynchronously planned diff; settled rendering always uses actual execution details. Oversized non-delete previews are omitted without blocking an otherwise valid edit. Delete confirmation still requires the complete planned diff and fails before prompting when that diff exceeds the preview ceiling. Inputs, operations, target size, staged content, matcher work, diff output, path canonicalization, and queue depth are bounded. See [ADR: local unified-edit dialect](../../docs/adr/0001-local-unified-edit-dialect.md).

## Renderers

Tool-display registers reasoned, self-framed renderers for `read`, `grep`, `find`, `ls`, and `write` by default. Its `edit` registration follows session config: it installs the candidate override when explicitly enabled and delegates to Pi's built-in edit definition when disabled. `search.enabled` owns `grep`/`find`/`ls` together. Pending and settled tools use stable two-row presentation, Pi theme pending/success/error backgrounds, width-aware emoji and tail-preserving truncation, and elapsed time. Tool icons and names use Tidy-style theme groups: accent for read/search tools, warning for edit/write, and `thinkingXhigh` for RTK-owned bash. Collapsed reasoning, targets, commands, and summaries collapse whitespace and strip terminal control sequences; multiline bash commands show their first non-empty line plus the remaining non-empty line count. Partial bash results keep the pending two-row summary instead of repeating the command. Expanded output keeps its original line structure. `Ctrl+O` expansion reveals the existing detailed output beneath the two-row summary. Full reads retain their target and pagination-ignored badges.

`edit` renders the final applied diff from tool details. `write` captures previous file content before execution and renders a final diff after success. Final diffs use the standard tool block shell/background, compact summaries by default, expand to unified diffs on narrow terminals, switch to split diffs on wide terminals, color additions/removals, and collapse expanded output to `diff.previewLines` when `diff.collapsed` is true. Split diffs keep path and hunk meta rows compact across the full diff width: unchanged paths render once, while renames/path changes render old-to-new. If previous content cannot be captured safely, `write` falls back to a capped compact summary instead of a diff; previous-content capture is limited to paths inside the workspace.

RTK remains the `bash` owner. Tool-display exports the shared bash presentation that RTK imports, but does not register `bash`. `output.bash.enabled` defaults to `true`; setting it to `false` disables only the shared reasoned presentation and preserves RTK ownership, rewriting, execution, native bash schema, and native renderers.

## Registration and ownership

`tool-display` is active through `package.json -> pi.extensions` as `./extensions/tool-display`. The retired `read-patch` extension is intentionally not registered.

Runtime ownership:

- `tool-display`: `read`, optional `grep`/`find`/`ls`, session-configured candidate-or-built-in `edit` delegation, optional `write`
- `rtk`: `bash` execution, rewrite, statistics, and compaction metadata

Keep `./extensions/rtk` before `./extensions/tool-display` in `package.json`. RTK owns `bash`; tool-display owns the other tool renderers and read override path.

## Attribution

The two-row tool presentation is adapted from Mikey O'Brien's [`pi-tidy-tools`](https://github.com/mikeyobrien/pi-tidy-tools), licensed under the MIT license.

The full-read behavior is adapted from the former local `read-patch` extension in this repository. No external upstream source or external license applies to that local code path.

The unified-edit parser, planner, matcher, and migration behavior are ported from Armin Ronacher and contributors' [`mitsuhiko/agent-stuff`](https://github.com/mitsuhiko/agent-stuff), `extensions/unified-edit.ts` at commit [`4bce45560fa55ace2f5dc8634a63a2af464ddc8b`](https://github.com/mitsuhiko/agent-stuff/commit/4bce45560fa55ace2f5dc8634a63a2af464ddc8b), under the Apache License 2.0, with local modifications documented in the ADR and `UNIFIED_EDIT_UPSTREAM.md`.

The root project license is MIT; keep copied or adapted external materials attributed near their usage.
