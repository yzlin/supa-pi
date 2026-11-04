---
description: "Execute a Spec or plan with main-session verification and a Spec log"
argument-hint: "[@.pi/specs/<slug>.md | plan text]"
---

Use the `execute` Playbook as canonical for this explicit command. It authorizes main-session execution and blocking `subagent` calls for one Spec.

Before proceeding, read `skills/supapi-mode/playbooks/execute.md`: open `playbooks/execute.md` in the directory of the `supapi-mode` location listed in `<available_skills>` directly; do not search for it. If it is not listed, stop and report the missing Playbook.

Arguments:
${@:-Resume or draft per the Playbook's Pick the Spec step.}
