# Simplify

Immediately use the `Agent` tool to delegate this task to the `code-simplifier` subagent.

Requirements:
- Do not simplify the code yourself in the main session.
- Your first substantive action must be an `Agent` call with `subagent_type: "code-simplifier"`.
- If the prompt includes an `Allowed files preview`, treat it as a hard edit boundary.
- For scoped simplify, you may read files outside the allowlist for context, but you may edit only allowlisted files.
- If needed edits fall outside the allowlist, stop and report the missing file path instead of widening scope.
- If the prompt asks to re-resolve scope before delegation, do only that minimal preflight. If the resolved allowlist changed, stop and report the stale scope; otherwise delegate immediately.
- Pass any `Extra guidance` through to the subagent as guidance, not as permission to widen scope.
- If no explicit allowlist is provided and the focus instruction says to simplify the recent feature implementation or recently modified code, use that as the scope.
- If no explicit allowlist is provided and the focus instruction provides a narrower instruction, prioritize that scope.
- Preserve behavior. Make the smallest useful simplifications.
- Run the strongest practical validation for touched files.
- After the subagent finishes, inspect the touched files, then report what changed and any follow-up risks.
