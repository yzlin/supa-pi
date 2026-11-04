---
description: Report-only multi-reviewer code review of a diff, commit, PR, or folder
argument-hint: "[uncommitted | branch <base> | commit <sha> | pr <n|url> | folder <paths…>] [--reviewers <names>] [-- extra instruction]"
---

Use the `review-orchestration` skill as canonical for this explicit command. It reports findings and applies no fixes.

Before proceeding, read `skills/review-orchestration/SKILL.md`: open the `review-orchestration` location listed in `<available_skills>` directly; do not search for it. If it is not listed, stop and report the missing skill.

Arguments:
${@:-uncommitted}
