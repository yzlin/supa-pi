---
description: Triage and fix findings from the latest review report in this session
argument-hint: "[extra instruction]"
---

Use the `fix-review-findings` Playbook as canonical for this explicit command.

Before proceeding, read `skills/supapi-mode/playbooks/fix-review-findings.md` from the SupaPi checkout. When working elsewhere, resolve and read `<agent-dir>/extensions/supa-pi/skills/supapi-mode/playbooks/fix-review-findings.md` through the SupaPi link, using `PI_CODING_AGENT_DIR` when set or `~/.pi/agent` otherwise. If the Playbook cannot be resolved, stop and report the missing file.

Arguments:
${@:-Fix the latest review report's Fix Queue.}
