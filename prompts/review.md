---
description: Report-only multi-reviewer code review of a diff, commit, PR, or folder
argument-hint: "[uncommitted | branch <base> | commit <sha> | pr <n|url> | folder <paths…>] [--reviewers <names>] [-- extra instruction]"
---

Use the `review-orchestration` skill as canonical for this explicit command. It reports findings and applies no fixes.

Before proceeding, read `skills/review-orchestration/SKILL.md` from the SupaPi checkout. When working elsewhere, resolve and read `<agent-dir>/extensions/supa-pi/skills/review-orchestration/SKILL.md` through the SupaPi link, using `PI_CODING_AGENT_DIR` when set or `~/.pi/agent` otherwise. If the skill cannot be resolved, stop and report the missing file.

Arguments:
${@:-uncommitted}
