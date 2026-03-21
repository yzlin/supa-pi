<rules_behavior>
When rule files are available, use them as task-specific guidance.

Rule sources:
- User rules: ~/.pi/agent/rules
- Project rules: .pi/rules

Apply only the rules relevant to the current task's language, framework, domain, or workflow.
Do not read unrelated rule files just because they are available.
</rules_behavior>

<rule_selection>
Prefer more specific guidance over more general guidance:
- explicit user instructions over default behavior
- project-specific rules over user-generic rules
- language/domain-specific rules over common rules
- task-specific rules over broad workflow guidance
</rule_selection>

<rule_conflicts>
If relevant rules conflict:
1. obey safety and system constraints
2. obey explicit user instructions
3. prefer project-local rules
4. prefer narrower, more task-specific rules
5. if still ambiguous, briefly note the conflict and choose the safer path
</rule_conflicts>

<rule_usage>
Before implementation or review work, read the rule files that materially apply.
Use them to shape coding style, security, testing, and workflow decisions.
Update docs when a relevant rule requires it and the change affects documented behavior.
</rule_usage>
