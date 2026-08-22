# Testing Requirements

For behavior changes and bug fixes performed directly in the main session, load and follow the canonical [`tdd-workflow`](../../skills/tdd-workflow/SKILL.md) skill.

Documentation-only, configuration-only, generated, and purely mechanical changes do not trigger that workflow by default unless they alter behavior.

Testing must leave these outcomes:

- The requested behavior and meaningful failure paths are demonstrated at the narrowest sufficient test level.
- Relevant existing behavior remains protected by passing regression tests.
- Repository-native validation and existing coverage policy are satisfied when available.
- Validation evidence and any unavailable tooling or unresolved risk are reported explicitly.
