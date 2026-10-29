# IMPROVE CODEBASE ARCHITECTURE

Run a read-only architecture review that finds deepening opportunities in the codebase. Adapt the workflow from Matt Pocock's `improve-codebase-architecture` skill for this repo.

This command prompt is composed with these required support docs:

- `LANGUAGE.md` — strict architecture vocabulary.
- `DEEPENING.md` — principles, candidate report shape, and implementation-plan stopping point.
- `INTERFACE-DESIGN.md` — Interface alternative workflow after candidate selection.

## HARD RULES

- Read-only by default. Do not edit files, implement code, create branches, commit, or run destructive commands.
- MUST NOT create or modify execution-ledger assignments or goal state. This command does not authorize /execute.
- Delegate exploration to blocking `subagent({agent: "explorer", task})` calls only when the scope is broad: no scope instruction, or a scope that spans multiple unfamiliar Modules. For a narrow scope that direct reads can cover, explore in the main session.
- Use the optional scope instruction when present. If absent, survey the repository broadly, then narrow based on explorer findings.
- Report missing `CONTEXT.md`, `CONTEXT-MAP.md`, or `docs/adr/` / ADR docs as missing context. Do not block on missing docs.
- Use the architecture terms in this document exactly: **Module**, **Interface**, **Implementation**, **Depth**, **Seam**, **Adapter**, **Leverage**, **Locality**.
- Avoid substitute terms such as component, service, API, or boundary when describing architecture.
- For complexity findings, use the existing report fields to name the exact location, concrete unnecessary mechanism to cut, replacement or explicitly `none`, and evidence/verification that required contracts remain supported.
- Keep the existing report/schema: no replacement schema, complexity-only mode, or line-count score; do not hide safety findings.
- Produce analysis and plans only. Do not implement.

## WORKFLOW

### 1. Load durable context

Inspect these context paths before code exploration, and include them in any explorer task:

- `CONTEXT.md`
- `CONTEXT-MAP.md`
- `docs/adr/`
- ADR files elsewhere if obvious

If any are missing, include a short "Missing context" note in the final report. Continue the review.

### 2. Explore the scope

Look for architecture friction, shallow Modules, coupling across Seams, testing pain, domain vocabulary, and relevant ADR constraints.

- **Narrow scope:** inspect durable context, then read the scoped files directly in the main session.
- **Broad scope:** use blocking `subagent({agent: "explorer", task})` calls, with disjoint read-only scopes when the scope splits cleanly. Pass a self-contained task with the scope, read-only/no-implementation constraints, evidence requirements, relevant context paths, and the focus list above. Children are fresh and do not inherit the parent conversation. Ask the explorer to inspect durable context before code exploration and report missing context, not to write artifacts. Wait for every explorer report before main-session verification and synthesis, then use direct tool reads to verify specific findings. If delegation is unavailable for a broad scope, report the blocker and stop; do not substitute another role or silently perform the broad exploration yourself.

### 3. Candidate selection

Use `DEEPENING.md` to produce the initial candidate report. Do not propose final Interfaces in the candidate report. Ask which candidate should be turned into an implementation plan.

### 4. Interface design only when needed

Use `INTERFACE-DESIGN.md` only after the user selects a candidate or explicitly asks for Interface alternatives. Do not use Interface-design agents for the initial candidate report.

### 5. End in implementation plan only

After the candidate is selected and any needed Interface design is complete, stop at an implementation plan. The final answer must not implement. Use the implementation-plan shape from `DEEPENING.md`.
