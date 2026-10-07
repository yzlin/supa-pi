# Simplify

Use the `simplify` skill behavior as canonical. This retained reference is not a separate command prompt.

Immediately delegate this task with blocking `subagent({agent: "code-simplifier", task})`.

Requirements:
- Do not simplify the code yourself in the main session.
- Your first substantive action must be a blocking `subagent({agent: "code-simplifier", task})` call.
- Pass a self-contained task with the scope, editable files, stale-check results, constraints, extra guidance, and validation requirements. Children are fresh and do not inherit the parent conversation. Await the report; let the simplifier finish, validate, and report.
- If delegation is unavailable, report the blocker and stop; do not replace the role or silently simplify in the main session.
- If the prompt includes `Editable files`, treat that list as the hard edit boundary.
- For scoped simplify, you may read files outside editable files for context, but you may edit only editable files.
- Do not edit ignored lockfiles or unsupported changed files.
- If needed edits fall outside editable files, stop and report the missing file path instead of widening scope.
- If the prompt asks to re-resolve scope before delegation, do only that minimal preflight. Compare editable files only. Ignore lockfile drift. Stop and report the stale scope if editable files changed or new unsupported non-lock files appeared; otherwise delegate immediately.
- Pass any `Extra guidance` through to the subagent as guidance, not as permission to widen scope.
- If no explicit editable files list is provided and the focus instruction says to simplify the recent feature implementation or recently modified code, use that as the scope.
- If no explicit editable files list is provided and the focus instruction provides a narrower instruction, prioritize that scope.
- Preserve behavior. Make the smallest useful simplifications.
- Run the strongest practical validation for touched files.
- After the subagent finishes, inspect the touched files, then report what changed and any follow-up risks.
