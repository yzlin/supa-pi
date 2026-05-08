# read-patch

`read-patch` overrides Pi's built-in `read` tool for loaded skill files.

## Behavior

- Matches only exact loaded `Skill.filePath` values.
- Compares paths by absolute `realpath`, so relative paths and symlinks resolve consistently.
- For matched skill files, reads the full file and ignores `offset` and `limit`.
- Returns the raw skill markdown as model-visible text.
- Caps full skill reads at 256KB. Larger skill files fail instead of returning truncated content.
- Marks full skill reads in tool `details.readPatch.fullSkillRead` so RTK output compaction skips them.

Non-skill reads delegate to the built-in `read` tool unchanged.

## Registration

Active through `package.json -> pi.extensions` as `./extensions/read-patch.ts`.
