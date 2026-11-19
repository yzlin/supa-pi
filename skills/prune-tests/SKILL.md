---
name: prune-tests
description: "Delete or rewrite tests that guard no behavior, and production code that only those tests use. Use for /prune-tests or an explicit request to prune tests. Use /simplify for production code and /review for defects."
---

# Prune tests

Keep a test only if it guards intended behavior: it changes only when that behavior changes, and fails only when it regresses. Delete or rewrite every other test in scope.

The `test-behavior-not-implementation` Principle owns the judgment: break the behavior, then change the internals. Read it before you start. This skill adds duplicates, tests of the past, the non-use proof, and the edit boundary.

## Scope

- Take the paths after `/prune-tests`. With no path, use the test files changed in `git status` and in `git diff --name-only $(git merge-base origin/HEAD HEAD)`. If that set is empty, stop and ask for a path.
- Edit only test files in scope, plus production code you prove only those tests use. Read anything else, but edit nothing else. The one exception is a temporary break in the Prove it step, which you restore before you go on.
- Before editing, run `git status --porcelain --untracked-files=all` and `bun test` (or the repository's test command) on the scope. Record both. If tests already fail, stop and report them, because then a red run proves nothing.

## Classify each test

Go through the steps in order. The first one that fits decides.

1. **Duplicate.** Another kept test already guards the same behavior with the same or a stronger assertion. Delete the weaker copy. Name the test you kept.
2. **The past.** The test checks that removed code, text, or files stay gone. A return of the removed code would be a decision, not a regression. Delete it.
3. **Nothing.** No change to the code under test can make it fail: it tests the platform or framework, checks what a mock of the unit under test returns, checks data the test built itself, or repeats what the type checker already proves. Delete it.
4. **The implementation.** It fails when the internals change but behavior does not: private state, call order, which helper ran, or an expected value built from the same logic as the code. If it also covers behavior that callers rely on, rewrite it against that behavior. Otherwise delete it.
5. **Behavior.** Keep it.

Contract tests on prompt, skill, or doc text guard wiring: an alias that points to its skill, a section other code or tests read, a rule a Playbook depends on. A negative assertion (`not.toContain`, `not.toMatch`) is the past when it only records a removal. Keep it when it enforces a current rule that no positive assertion covers, such as "this skill must not delegate". When you cannot tell, keep the test and list it under `Unsure`.

## Prune

- Delete in place. Do not comment tests out or mark them skipped.
- For a rewrite, drive the code through its public interface. Take the expected value from the requirement, not from the code.
- Delete production code only when it exists only for the tests you removed. Use the non-use proof from the `simplify` skill's dead-code bullets: static, dynamic, config, generated, test, and public-consumer surfaces. If any surface is unproven, keep the code and report it.
- Delete a test file when it has no tests left. Move it to Trash with `trash`, never `rm`.

## Prove it

- Run the scoped tests again. They must pass.
- Before each break, copy the production file to a temp directory outside the repository. After the run, copy it back and confirm with `git diff` that the file matches its state before the break. Never use `git checkout`, `git restore`, or `git stash` for this.
- For each rewritten test, break the behavior it guards in the production code, run it, and see it fail. Then restore the code and see it pass. Paste both results.
- For each deleted duplicate, break the behavior once, see the kept test fail, then restore the code and see it pass.
- Run `git status --porcelain --untracked-files=all` again. A changed path outside the edit boundary that you did not change belongs to someone else: report it, but do not revert it. Then run `bun run check`.

## Report

- `## Deleted`: per test, `file` › `test name` and its reason: duplicate of `<kept test>`, past, nothing, or implementation.
- `## Rewritten`: per test, the old assertion, the new one, and the break-then-restore output.
- `## Production code removed`: per symbol, the non-use evidence.
- `## Unsure`: tests you kept because you could not classify them, with what would decide each one.
- `## Validation`: the commands you ran and their results.

Write the report in Plain report style per the `plain-report` skill.

**Principles:** `test-behavior-not-implementation`, `subtract-before-you-add`, `prove-it-works`.

## Attribution

Adapted from Maze's MIT-licensed [caldoai `prune-tests` skill](https://github.com/caldoai/skills/tree/d5b68dace378219890d821adb3685538e2c69b04/skills/prune-tests), pinned to commit `d5b68dace378219890d821adb3685538e2c69b04`; see `LICENSE.upstream`. The criteria are rewritten to use the local Principle, and scope, proof, and report steps are added for Pi.
