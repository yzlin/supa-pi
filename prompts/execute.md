---
description: Execute a Spec or plan with main-session verification and a Spec log: /execute [@.pi/specs/<slug>.md | plan]
argument-hint: "[@.pi/specs/<slug>.md | plan text]"
---

Use the `execute` Playbook as canonical for this explicit command. It authorizes main-session execution and blocking `subagent` calls for one Spec.

Before proceeding, read `skills/supapi-mode/playbooks/execute.md` from the SupaPi checkout. When working elsewhere, resolve and read `<agent-dir>/extensions/supa-pi/skills/supapi-mode/playbooks/execute.md` through the SupaPi link, using `PI_CODING_AGENT_DIR` when set or `~/.pi/agent` otherwise. If the Playbook cannot be resolved, stop and report the missing file.

Arguments:
${@:-Resume or draft per the Playbook's Pick the Spec step.}
