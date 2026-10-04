## Result

The `/review` command now rejects findings without a file path. I added a check in `extensions/review/public-workflow.ts` and a regression test.

## Verified

- The new test fails before the change and passes after it.
- `bun run check` passes.

## Steps to reproduce

1. Run `/review` on a branch with one change.
2. Give a finding an empty `file` field.
3. Check that the workflow rejects the finding.

## Unknown

I did not run a live review. The model may still omit paths in other ways.
