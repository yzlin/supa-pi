# tool-display

Local Pi extension for tool display ownership. It replaces the retired local `read-patch` extension.

## Config

Precedence:

1. defaults
2. global config: `~/.pi/agent/tool-display.json`
3. project config: `.pi/tool-display.json`

Shape:

```json
{
  "tools": {
    "read": { "enabled": true, "fullSkillRead": true },
    "search": { "enabled": true },
    "edit": { "enabled": true },
    "write": { "enabled": true }
  },
  "output": {
    "read": { "mode": "compact", "collapsed": true, "previewLines": 20 },
    "search": { "mode": "compact", "collapsed": true, "previewLines": 20 },
    "bash": {
      "mode": "compact",
      "collapsed": true,
      "previewLines": 20,
      "rtkHints": true
    }
  },
  "diff": { "enabled": true, "collapsed": true, "previewLines": 80 }
}
```

See `tool-display.example.json` for a project config example matching the default compact renderer setup.

Commands:

- `/tool-display show` displays the resolved config.
- `/tool-display preset compact|verbose|off` writes `.pi/tool-display.json`.
- `/tool-display reset` writes default config to `.pi/tool-display.json`.

## Read path

`read` preserves the former read-patch behavior for loaded skill files: when a requested path resolves to a registered skill file, pagination is ignored and the full skill file is returned up to a 256 KiB cap.

## Renderers

Tool-display v1 registers compact renderers for `read`, `grep`, `find`, `ls`, `edit`, and `write` when their config flags are enabled. `search.enabled` owns `grep`/`find`/`ls` together.

`edit` renders the final applied diff from tool details. `write` captures previous file content before execution and renders a final diff after success. Final diffs use the standard tool block shell/background, compact summaries by default, expand to unified diffs on narrow terminals, switch to split diffs on wide terminals, color additions/removals, and collapse expanded output to `diff.previewLines` when `diff.collapsed` is true. If previous content cannot be captured safely, `write` falls back to a capped compact summary instead of a diff; previous-content capture is limited to paths inside the workspace.

RTK remains the `bash` owner. Tool-display exports the shared compact bash renderer that RTK imports, but does not register `bash`.

## Registration and ownership

`tool-display` is active through `package.json -> pi.extensions` as `./extensions/tool-display`. The retired `read-patch` extension is intentionally not registered.

Runtime ownership:

- `tool-display`: `read`, optional `grep`/`find`/`ls`, optional `edit`, optional `write`
- `rtk`: `bash` execution, rewrite, statistics, and compaction metadata

Keep `./extensions/rtk` before `./extensions/tool-display` in `package.json`. RTK owns `bash`; tool-display owns the other tool renderers and read override path.

## Attribution

The full-skill `read` behavior is adapted from the former local `read-patch` extension in this repository. No external upstream source or external license applies to that local code path. The root project license remains unresolved; keep copied or adapted external materials attributed near their usage.
