---
description: "Find what a change could break outside its diff, and prove the fact it is safe because of"
argument-hint: "[uncommitted | branch <base> | commit <sha> | pr <n>] [-- concern]"
---

Use the `blast-radius` skill as canonical for this explicit command. It edits no source files.

Before proceeding, open the `blast-radius` location listed in `<available_skills>` directly; do not search for it. If it is not listed, stop and report the missing skill.

Target:
${@:-uncommitted}
