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
- `/rtk stats` opens a custom TUI dashboard instead of plain notify text
- stats are **session-only**; switching sessions or clearing stats resets the dashboard
- token counts in `/rtk stats` are **estimated**, not exact

## `/rtk stats`

The dashboard includes:
- summary totals for tracked commands
- estimated input/output/saved tokens
- total/average execution time
- efficiency meter
- ranked "By Command" rows
- right-side impact chart on wider terminals
- clear empty/off states when RTK or savings tracking is disabled

Ranking defaults to saved tokens, then total input tokens, count, and time.

Tracked command rows currently aggregate:
- rewritten `bash` tool commands by executed command text
- `read`
- `grep`
- user `!cmd` executions (timing only unless output compaction savings are available)

## Config

Project config path:
- `.pi/rtk.json`
