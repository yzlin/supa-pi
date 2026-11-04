---
description: Draft a PR body from the branch diff and submit it for review
argument-hint: "[--base <branch>]"
---

Use the `opening-a-pr` Playbook as canonical for this explicit command.

Before proceeding, read `skills/supapi-mode/playbooks/opening-a-pr.md` from the SupaPi checkout. When working elsewhere, resolve and read `<agent-dir>/extensions/supa-pi/skills/supapi-mode/playbooks/opening-a-pr.md` through the SupaPi link, using `PI_CODING_AGENT_DIR` when set or `~/.pi/agent` otherwise. If the Playbook cannot be resolved, stop and report the missing file.

Arguments:
${@:-Use the repository default branch as base.}
