# pi-rtk

Local pi extension for RTK command rewrite + output compaction.

## Defaults

`outputCompaction` is on by default for:
- `bash`
- `grep`
- `read`

Default limits:
- `maxLines: 400`
- `maxChars: 12000`
- `trackSavings: true`
- `readSourceFilteringEnabled: false`

## Behavior

- `bash` output is compacted from the tail
- `grep` and `read` output are compacted from the head
- compaction runs in `tool_result`, after the built-in tool finishes
- non-text payloads (for example image reads) are left unchanged
- `/rtk` defaults to the stats dashboard; `/rtk stats` opens the same custom TUI view instead of plain notify text
- stats are **session-only**; switching sessions or clearing stats resets the dashboard
- token counts in `/rtk stats` are **estimated**, not exact

## `/rtk` / `/rtk stats`

The dashboard includes:
- overview totals for tracked commands
- estimated input/output/saved tokens
- total/average execution time
- efficiency meter
- ranked "By Tool" rows
- ranked "Top Command Families" rows
- ranked "Raw Command Rows" for exact executed commands
- clear empty/off states when RTK or savings tracking is disabled

Ranking defaults to saved tokens, then total input tokens, count, and time.

Tracked groupings currently aggregate:
- tools: `bash`, `read`, `grep`, and `user-bash`
- command families: normalized bash/user-bash command prefixes plus `read`/`grep`
- raw command rows: exact rewritten/executed command text for `bash` and `user-bash`, plus `read`/`grep`

## Config

Project config path:
- `.pi/rtk.json`
