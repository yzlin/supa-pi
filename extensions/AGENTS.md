# AGENTS.md

## Extension Boundaries

- Extensions under `extensions/` are isolated.
- Do not import code from one sibling extension into another.
- If an extension needs behavior, styling, or helpers that exist in another extension, copy the minimal needed logic locally instead of creating a sibling-extension dependency.
- Only move logic into a shared non-extension module when the user explicitly asks for that refactor.
