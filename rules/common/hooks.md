# Hooks System

## Tool Permissions

Configure tool permissions in `opencode.json`:

```json
{
  "permission": {
    "bash": "ask",
    "write": "allow",
    "mcp_*": "ask"
  }
}
```

Permission levels:
- **`"allow"`** — executes without approval
- **`"deny"`** — tool cannot be used
- **`"ask"`** — requires user approval before execution

Use `"ask"` for tools with side effects (bash, write); use `"allow"` for read-only tools in trusted workflows.

## todowrite / todoread Best Practices

Use the `todowrite` tool to:
- Track progress on multi-step tasks
- Verify understanding of instructions
- Enable real-time steering
- Show granular implementation steps

Use `todoread` to check current task state before proceeding.

Todo list reveals:
- Out of order steps
- Missing items
- Extra unnecessary items
- Wrong granularity
- Misinterpreted requirements
