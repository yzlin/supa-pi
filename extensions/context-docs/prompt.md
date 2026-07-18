# Context Docs Runtime Envelope

- Treat the resolved command input as authoritative.
- Keep all work inside the resolved target root.
- Do not create, modify, schedule, or manage pi-tasks.
- Never put secrets, credentials, tokens, private keys, or raw sensitive data in durable docs.
- Preserve existing structure and conventions; make the smallest safe edits.
- Use the canonical `context-docs` skill for all shared and command-specific workflow behavior.
- Summarize files read and changed, decisions captured, open questions, and validation performed.
