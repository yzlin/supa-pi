# Performance Optimization

## Model Selection Strategy

**gpt-5.3-codex-spark** (lightweight, fast, cost-efficient):
- Lightweight agents with frequent invocation
- Pair programming and code generation
- Worker agents in multi-agent systems

**gpt-5.4** (best coding model, default):
- Main development work
- Orchestrating multi-agent workflows
- Complex coding tasks

**gpt-5.4 with xhigh reasoning** (deepest reasoning):
- Complex architectural decisions
- Maximum reasoning requirements
- Research and analysis tasks

Configure in `opencode.json`:
```json
{
  "model": "openai/gpt-5.4",
  "small_model": "openai/gpt-5.3-codex-spark"
}
```

## Context Window Management

Avoid last 20% of context window for:
- Large-scale refactoring
- Feature implementation spanning multiple files
- Debugging complex interactions

Lower context sensitivity tasks:
- Single-file edits
- Independent utility creation
- Documentation updates
- Simple bug fixes

## Build Troubleshooting

If build fails:
1. Use **build-error-resolver** agent
2. Analyze error messages
3. Fix incrementally
4. Verify after each fix
