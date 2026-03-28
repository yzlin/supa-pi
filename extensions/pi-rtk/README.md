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

## Config

Project config path:
- `.pi/rtk.json`
