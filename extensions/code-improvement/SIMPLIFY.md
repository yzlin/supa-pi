# Simplify

Immediately use the `Agent` tool to delegate this task to the `code-simplifier` subagent.

Requirements:
- Do not simplify the code yourself in the main session.
- Your first substantive action must be an `Agent` call with `subagent_type: "code-simplifier"`.
- If the focus instruction says to simplify the recent feature implementation or recently modified code, use that as the scope.
- If the focus instruction provides a narrower instruction, prioritize that scope.
- Preserve behavior. Make the smallest useful simplifications.
- Run the strongest practical validation for touched files.
- After the subagent finishes, inspect the touched files, then report what changed and any follow-up risks.
