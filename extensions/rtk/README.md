# rtk

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

- `rtk rewrite` accepts exit 0 or 3 with non-empty output; exit 3 rewrites without a permission prompt. Exit 1 (no equivalent) and 2 (deny verdict) pass the raw command through unchanged, without blocking; errors, timeouts, empty rewrite output, and unexpected exit codes fall back to the raw command.
- `bash` output is compacted from the tail
- `grep` and `read` output are compacted from the head
- `read` results marked `details.toolDisplay.fullRead === true` bypass compaction, including configured full-read targets and loaded skill files
- compaction runs in `tool_result`, after the built-in tool finishes
- nested tool calls (with `parentToolCallId`, e.g. from codemode scripts) are not output-compacted; command rewriting still applies
- compacted results include `details.rtkCompaction` metadata when output text changes
- non-text payloads (for example image reads) are left unchanged
- `/rtk` defaults to the stats dashboard; `/rtk stats` opens the same custom TUI view instead of plain notify text
- stats are **session-only**; switching sessions or clearing stats resets the dashboard
- token counts in `/rtk stats` are **estimated**, not exact
- RTK always owns and executes `bash` with a required `reasoning` field: a short present-tense intent, at most 12 words, without restating the target. Reasoning is stripped before rewriting/execution.
- results include `details.toolDisplay.durationMs`, preserving existing details and compaction metadata
- RTK registers no renderers and imports no tool-display code. Tool-display's renderer resolver draws bash independently; when its bash drawing is off, Pi's native bash renderers apply. Drawing configuration never changes RTK's schema or execution.

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
