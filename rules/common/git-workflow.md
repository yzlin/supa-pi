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

## Pull Request Workflow

Use the canonical `pr` skill (`/pr`) as the single source for PR preflight, diff review against base, evidence, the PR body template, and one-confirm submission.

> For the full development process (planning, TDD, code review) before git operations,
> see [development-workflow.md](./development-workflow.md).
