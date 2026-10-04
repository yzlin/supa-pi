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
    "read": { "enabled": true, "mode": "compact", "collapsed": true, "previewLines": 20 },
    "search": { "enabled": true, "mode": "compact", "collapsed": true, "previewLines": 20 },
    "bash": {
      "enabled": true,
      "mode": "compact",
      "collapsed": true,
      "previewLines": 20,
      "rtkHints": true
    },
    "tasks": { "enabled": true, "collapsed": true, "previewLines": 20 },
    "mcp": { "enabled": true, "collapsed": true, "previewLines": 20 },
    "codemode": { "enabled": true, "collapsed": true },
    "web": { "enabled": true, "collapsed": true, "previewLines": 20 },
    "fallback": { "enabled": true, "mode": "compact", "collapsed": true, "previewLines": 20 }
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

`tools.*.enabled` gates execution/schema overrides only; it does not control drawing. Drawing gates are `output.read.enabled` for read, `output.search.enabled` for grep/find/ls, `diff.enabled` for edit/write, `output.bash.enabled` for bash, `output.tasks/mcp/codemode/web.enabled` for the companion groups below, and `output.fallback.enabled` for non-owned tools. All drawing gates default on, are normalized as booleans, and follow the same layer precedence. The resolver reads current session config rather than capturing registration-time gates; preview settings are also read when rendering. Missing reasoning arguments in native tools or old sessions fall back to a target/args summary.

The compact and verbose presets enable every drawing gate. The off preset disables every drawing gate as well as the execution/schema overrides. Companion gates `output.tasks`, `output.mcp`, and `output.web` use `{enabled, collapsed, previewLines}`; `output.codemode` uses only `{enabled, collapsed}`, with the same normalization and project > global > default precedence as existing output settings. They are on by default and in the compact preset. Codemode has fixed previews (10 visual script lines and 8 nested calls); stale `output.codemode.previewLines` is ignored with a warning in `/tool-display show`. The verbose preset sets `collapsed: false` to reveal the full codemode body. Fallback previews use `mode`, `collapsed`, and `previewLines`; `Ctrl+O` reveals the complete result body.

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

Tool-display draws through one `pi.registerToolRenderer()` Renderer resolver, not through execution registrations. For owned names (`read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`, and the companion names below), an enabled drawing gate returns tool-display's `renderShell: 'self'`, `renderCall`, and `renderResult` without calling `next()`. A disabled gate returns `next()` unchanged. `tools.search.enabled` independently gates the reasoning/schema override for `grep`/`find`/`ls` together. With candidate edit never enabled, no edit is registered: Pi's built-in schema and execution stay in place and the resolver draws its final `details.diff`. After opt-in, a session start or switch with candidate edit disabled restores Pi's native definition without renderers; later disabled sessions refresh that definition for their working directory because Pi retains extension tool registrations and exposes no unregister API. Except for codemode's single summary header with script/call rows below, pending and settled tools use stable two-row presentation, Pi theme pending/success/error backgrounds, width-aware emoji and tail-preserving truncation, and elapsed time. Tool icons and names use Tidy-style theme groups: accent for read/search, web, and MCP tools; warning for edit/write and tasks; and `thinkingXhigh` for bash and codemode. Icons identify tool kind: 📖 read; 🔍 grep/find; 📁 ls; ✏️ edit; 📄 write; ⚡️ bash; 🧩 codemode; 🌐 web; 🔌 mcp/mcp__*; 📋 Task*; 🔧 Fallback. Collapsed reasoning, targets, commands, and summaries collapse whitespace and strip terminal control sequences; multiline bash commands show their first non-empty line plus the remaining non-empty line count. Partial bash results keep the pending two-row summary instead of repeating the command. Expanded output keeps its original line structure. `Ctrl+O` expansion reveals the existing detailed output beneath the two-row summary. Full reads retain their target and pagination-ignored badges.

Companion drawing owns these names only:

- `output.tasks`: `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskOutput`, `TaskStop`, `TaskExecute` from `@tintinweb/pi-tasks`
- `output.mcp`: exact `mcp` gateway and every `mcp__*` namespace proxy (the only prefix rule)
- `output.codemode`: Pi core `codemode`
- `output.web`: `pi-web-access` default names `web_search`, `source_check`, `fetch_content`, `get_search_content`

These tools use the same shell without execution or schema changes. Tasks, MCP, and web keep the two-row presentation. Task summaries use args and the first result text line; MCP summaries select the active gateway/proxy mode; web summaries use queries, URLs, counts, and success details. Args/details are parsed through narrow type guards. Unknown or mismatched shapes use the existing generic Fallback renderer for that call or result, without throwing. Codemode row 1 shows `codemode N tool call(s) · bytes → done in duration` (or error); pending rows show the live count from partial `details.calls` and `→ running elapsed`, without bytes. Before a result exists, only the name and running elapsed appear. Below it, every row uses the dim `┊` prefix: JavaScript-highlighted script (10 visual lines plus an expansion hint), then the last 8 nested calls with an earlier-calls hint. Calls show ✓ ok, ✗ error, … running, or ⊘ cancelled, followed by name, tail-fitted args, and duration. Compact view shows no script output. `Ctrl+O` or `collapsed: false` shows the full script, all calls with indented errors, and full output, stripping the exact leading `Script completed/failed / Wall time / Output:` text block. Partial results never show output. When `details.calls` is not an array, the result still uses Fallback; unknown call args independently use Fallback. Highlighting and expansion hints use Pi's public APIs. Automated renderer and TUI-smoke tests cover this layout; live TUI remains unverified.

`edit` renders the final applied diff from tool details. `write` captures previous file content before execution and renders a final diff after success. Final diffs use the standard tool block shell/background, compact summaries by default, expand to unified diffs on narrow terminals, switch to split diffs on wide terminals, color additions/removals, and collapse expanded output to `diff.previewLines` when `diff.collapsed` is true. Split diffs keep path and hunk meta rows compact across the full diff width: unchanged paths render once, while renames/path changes render old-to-new. If previous content cannot be captured safely, `write` falls back to a capped compact summary instead of a diff; previous-content capture is limited to paths inside the workspace.

Bash drawing is selected by tool name regardless of who registers or executes it, including native bash without RTK. RTK owns only execution, rewriting, statistics, compaction, and its required reasoning schema; it imports nothing from tool-display. RTK badges/hints appear only with `details.rtkCompaction`. Setting `output.bash.enabled` to `false` passes resolved renderers through without affecting execution or schema.

For non-owned tools, the Fallback renderer calls `next()` and fills only missing `renderCall`/`renderResult` fields. Complete resolved renderers remain unchanged. Pi's terminal `next()` normally merges registered definitions with built-in renderers, so it is rarely undefined; the fallback also handles undefined for unregistered tools such as disconnected MCP calls in resumed sessions. Its generic icon/name, optional reasoning, one-line args summary, duration, themed status background, and compact text body need no tool definition. Text blocks form the body, while images and other content use short placeholders. Terminal control sequences are stripped. The fallback chooses a self shell only when both renderers were generic; otherwise it preserves the resolved shell. Generic call headers also settle and clear their elapsed-time timers directly from Pi's final-result/error context, even when a custom result renderer is preserved.

## Registration and ownership

`tool-display` is active through `package.json -> pi.extensions` as `./extensions/tool-display`. The retired `read-patch` extension is intentionally not registered.

Runtime ownership:

- `tool-display` execution/schema: optional reasoned full-read `read`, optional reasoned `grep`/`find`/`ls`, opt-in candidate `edit`, optional reasoned `write` with diff-details capture; execution registrations contain no renderers
- `tool-display` drawing: one Renderer resolver for native owned names and the task/MCP/codemode/web names above, plus fill-only fallback composition, independently gated from execution
- companion packages and Pi core: retain all execution/schema ownership; their renderers draw when the matching companion gate is off
- `rtk`: `bash` execution, required reasoning schema, rewrite, statistics, and compaction metadata; no tool-display imports

Renderer resolvers compose in extension load order. Owned gates on make tool-display authoritative regardless of an upstream registered definition; gates off preserve `next()`. Non-owned tools keep every renderer they supply. `Agent` and `SubagentWorkflow`, adapter direct tools, `mcpScript`, and renamed web tool names are not owned and stay on their own renderers; names such as `mcpScript` and `xmcp__a` do not match `mcp__*`. In the live config, `pi-mcp-adapter` supplies `mcp` and `mcp__*`, while Pi's built-in MCP is disabled via `-builtin:mcp`; tool-display replaces either provider's renderers while the MCP gate is on. Disabled candidate edit is never re-registered solely for drawing. The never-enabled path registers no edit; after opt-in, disabled session reloads re-register native edit's schema and execution only to replace the retained candidate and refresh the working directory.

## Attribution

The two-row tool presentation is adapted from Mikey O'Brien's [`pi-tidy-tools`](https://github.com/mikeyobrien/pi-tidy-tools), licensed under the MIT license.

The full-read behavior is adapted from the former local `read-patch` extension in this repository. No external upstream source or external license applies to that local code path.

The unified-edit parser, planner, matcher, and migration behavior are ported from Armin Ronacher and contributors' [`mitsuhiko/agent-stuff`](https://github.com/mitsuhiko/agent-stuff), `extensions/unified-edit.ts` at commit [`4bce45560fa55ace2f5dc8634a63a2af464ddc8b`](https://github.com/mitsuhiko/agent-stuff/commit/4bce45560fa55ace2f5dc8634a63a2af464ddc8b), under the Apache License 2.0, with local modifications documented in the ADR and `UNIFIED_EDIT_UPSTREAM.md`.

The root project license is MIT; keep copied or adapted external materials attributed near their usage.
