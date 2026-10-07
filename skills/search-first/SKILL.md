---
name: search-first
description: Research-before-coding workflow. Check existing capabilities before writing custom code; invoke the researcher only for justified external research.
origin: ECC
---

# /search-first — Research Before You Code

Systematizes the "search for existing solutions before implementing" workflow.

## Trigger

Use this skill when:
- Starting a new feature that likely has existing solutions
- Adding a dependency or integration
- The user asks "add X functionality" and you're about to write code
- Before creating a new utility, helper, or abstraction

## Workflow

```
┌─────────────────────────────────────────────┐
│  1. NEED ANALYSIS                           │
│     Define what functionality is needed      │
│     Identify language/framework constraints  │
├─────────────────────────────────────────────┤
│  2. CHEAP CAPABILITY CHECK                  │
│     Repository → stdlib → native platform   │
│     → already-installed dependency          │
│     Stop when one meets the requirements.   │
├─────────────────────────────────────────────┤
│  3. CONDITIONAL RESEARCH                   │
│     Check local skills/MCP, then research   │
│     external packages/web only when needed. │
├─────────────────────────────────────────────┤
│  4. EVALUATE                               │
│     Compare fit, safety, correctness,       │
│     accessibility, edge cases, maintenance, │
│     license, and dependency cost.           │
├─────────────────────────────────────────────┤
│  5. DECIDE                                 │
│     Adopt / Extend / Compose / Build        │
├─────────────────────────────────────────────┤
│  6. IMPLEMENT                              │
│     Use the smallest complete solution that │
│     satisfies the actual requirements.      │
└─────────────────────────────────────────────┘
```

### Cheap capability check

Before external package/web research, check in order: repository -> stdlib -> native platform -> already-installed dependency.

1. **Repository** — search relevant modules, tests, scripts, and existing patterns.
2. **Stdlib** — check the language/runtime standard library.
3. **Native platform** — check capabilities supplied by the target platform or framework.
4. **Already-installed dependency** — inspect the manifest, lockfile, and existing usage.

At every step, test the capability against the actual requirements, including safety, correctness, accessibility, and edge cases. If a suitable existing capability meets those requirements, stop and use or reuse it; the same applies to a suitable local skill or MCP found before external research. Do not add a package or continue web research merely to compare alternatives. A justified package or research remains appropriate when these checks do not meet the requirements; do not treat a shorter implementation as automatically better.

## Decision Matrix

| Signal | Action |
|--------|--------|
| Existing capability meets actual requirements | **Adopt** — use or reuse it and stop research |
| Exact external match, well-maintained, MIT/Apache | **Adopt** — install and use directly |
| Partial match, good foundation | **Extend** — install + write thin wrapper |
| Multiple weak matches | **Compose** — combine 2-3 small packages |
| Nothing suitable found | **Build** — write custom, but informed by research |

## How to Use

### Quick Mode (inline)

Before writing a utility or adding functionality, mentally run through the cheap capability check:

For a simple local lookup, search the repository directly in the main session without launching a researcher.

0. Does this already exist in the repo? → `rg` through relevant modules/tests first
1. Does the stdlib provide it? → Check the language/runtime standard library
2. Does the native platform provide it? → Check the target platform or framework
3. Is a suitable dependency already installed? → Check the manifest, lockfile, and existing usage

If an existing capability meets the actual safety, correctness, accessibility, and edge-case requirements, stop and use or reuse it. Only when none fits:

4. Is there a relevant local skill or MCP? → Check `~/.pi/agent/mcp.json`, `~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`, and `.agents/skills/`
5. Is external package or web research justified? → Search npm/PyPI, GitHub, or the web as needed; do not choose a shorter implementation without checking fit

### Full Mode (agent)

For non-trivial functionality, run the cheap capability check and relevant local skill/MCP checks first. If no existing capability meets the actual requirements, use Full Mode. The main session owns research dispatch. Give the researcher a concrete question, project context, the completed local-check findings, and constraints, then use its comparison in the main session. This is a blocking call to a fresh task-only child; include all required context and any explicit artifact path. By default the researcher returns a brief without writing a file:

```
subagent({
  agent: "researcher",
  task: `
    Research existing tools for: [CONCRETE QUESTION]
    Language/framework: [LANG]
    Project context: [RELEVANT CONTEXT]
    Local checks already completed: [FINDINGS]
    Constraints: [ANY]

    Search: npm/PyPI, MCP servers, skills, GitHub/web as relevant
    Return: Structured comparison with recommendation tied to the actual requirements
  `
})
```

## Search Shortcuts by Category

### Development Tooling
- Linting → `eslint`, `ruff`, `textlint`, `markdownlint`
- Formatting → `prettier`, `black`, `gofmt`
- Testing → `jest`, `pytest`, `go test`
- Pre-commit → `husky`, `lint-staged`, `pre-commit`

### AI/LLM Integration
- OpenAI SDK → Context7 for latest docs
- Prompt management → Check MCP servers
- Document processing → `unstructured`, `pdfplumber`, `mammoth`

### Data & APIs
- HTTP clients → `httpx` (Python), `ky`/`got` (Node)
- Validation → `zod` (TS), `pydantic` (Python)
- Database → Check for MCP servers first

### Content & Publishing
- Markdown processing → `remark`, `unified`, `markdown-it`
- Image optimization → `sharp`, `imagemin`

## Integration Points

### With iterative-retrieval skill
Combine for progressive discovery:
- Cycle 1: Cheap capability check (repository, stdlib, native platform, installed dependency)
- Cycle 2: Check relevant local skills/MCP, then broaden to external research only if needed
- Cycle 3: Evaluate top candidates and test compatibility with project constraints

## Examples

The examples below assume the cheap capability check found no suitable existing capability.

### Example 1: "Add dead link checking"
```
Need: Check markdown files for broken links
Search: npm "markdown dead link checker"
Found: textlint-rule-no-dead-link (score: 9/10)
Action: ADOPT — npm install textlint-rule-no-dead-link
Result: Zero custom code, battle-tested solution
```

### Example 2: "Add HTTP client wrapper"
```
Need: Resilient HTTP client with retries and timeout handling
Search: npm "http client retry", PyPI "httpx retry"
Found: got (Node) with retry plugin, httpx (Python) with built-in retry
Action: ADOPT — use got/httpx directly with retry config
Result: Zero custom code, production-proven libraries
```

### Example 3: "Add config file linter"
```
Need: Validate project config files against a schema
Search: npm "config linter schema", "json schema validator cli"
Found: ajv-cli (score: 8/10)
Action: ADOPT + EXTEND — install ajv-cli, write project-specific schema
Result: 1 package + 1 schema file, no custom validation logic
```

## Anti-Patterns

- **Jumping to code**: Writing a utility without checking if one exists
- **Ignoring MCP**: Not checking if an MCP server already provides the capability
- **Over-customizing**: Wrapping a library so heavily it loses its benefits
- **Dependency bloat**: Installing a massive package for one small feature
