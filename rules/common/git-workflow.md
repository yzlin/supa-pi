# Git Workflow

## Commit Message Format
```
<type>: <description>

<optional body>
```

Types: feat, fix, refactor, build, ci, chore, docs, style, perf, test

### Pre-commit Checklist

1. `git status` — verify what's staged
2. Add explicit file paths — never `git add .` or `git add -A` blindly
3. `git diff --staged` — review changes before committing
4. Keep commits atomic (one logical change per commit)
5. Quote paths with special characters (`[]`, `()`, spaces) in git commands

Note: Configure attribution settings in `opencode.json` if needed.

## Pull Request Workflow

When creating PRs:
1. Analyze full commit history (not just latest commit)
2. Use `git diff [base-branch]...HEAD` to see all changes
3. Draft comprehensive PR summary
4. Include test plan with TODOs
5. Push with `-u` flag if new branch

> For the full development process (planning, TDD, code review) before git operations,
> see [development-workflow.md](./development-workflow.md).
