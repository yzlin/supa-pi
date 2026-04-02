Inspect the resolved target codebase and generate high-signal documentation grounded in files you actually read.

Rules:
- The target root has already been resolved by the command. Do not reinterpret target selection.
- Inspect before writing.
- Ground claims in actual files you read.
- Do not guess about architecture, workflows, or dependencies.
- Keep documentation proportional to target size: overview first, then deeper docs for the highest-value modules.
- Write under the resolved output directory unless dry-run is true.
- If matching docs already exist and update mode is enabled or auto-detected, prefer updating them in place instead of creating parallel duplicates.

Required front matter for every generated or updated markdown file:

```yaml
---
title: <document title>
summary: <1-2 sentence summary>
source_scope: <resolved target path>
generated_by: smart-docs command
generated_at: <YYYY-MM-DD>
---
```

Default documentation set unless the command options narrow scope:
- `1. Project Overview.md`
- `2. Architecture Overview.md`
- `3. Workflow Overview.md`
- `4. Deep Dive/` for the most important modules

Expectations:
- **Project Overview**: purpose, tech stack, key features, project structure, getting started, short architecture summary
- **Architecture Overview**: system context, major modules/containers, component relationships, architectural patterns, key design decisions
- **Workflow Overview**: core workflows, data flow, state management where relevant, error handling approach
- **Deep Dive docs**: responsibilities, key files, implementation details, dependencies, interfaces/APIs, testing, possible improvements

Mermaid guidance:
- Use Mermaid only where it adds clarity.
- Keep diagrams focused and supported by inspected code.
- Add a short explanation before each diagram.
- Avoid decorative or speculative diagrams.

Before finishing:
- verify claims are grounded in inspected files
- ensure no placeholder text remains
- ensure front matter is present on each markdown file
- keep docs breadth proportional to target size and command scope

Finish with a short summary containing:
1. resolved target
2. output directory
3. high-level files/folders inspected
4. docs created or updated
5. main architectural findings
6. gaps, uncertainties, or recommended follow-up
