---
title: smart-docs extension command
read_when:
  - changing /smart-docs command syntax, routing, or generated documentation behavior
status: active
---

# `/smart-docs`

`/smart-docs` deterministically resolves a target, output directory, and documentation scope, then asks the main agent to inspect the target and create or update grounded Markdown documentation.

## Syntax

```text
/smart-docs
/smart-docs <target>
/smart-docs [<target>] --out <dir>
/smart-docs [<target>] --update
/smart-docs [<target>] --overview-only
/smart-docs [<target>] --deep-dive <name,name>
/smart-docs [<target>] --dry-run
/smart-docs [<target>] [flags] -- <instruction>
```

Defaults:

- target: current working directory
- output directory: `<target>/docs`
- update mode: auto
- scope: overview plus relevant deep dives
- dry run: false
- instruction: default comprehensive documentation

Flags:

| Flag | Meaning |
|---|---|
| `--out <dir>` | Use an absolute output path or a path relative to the resolved target |
| `--update` | Prefer updating matching documentation in place |
| `--overview-only` | Skip deep-dive documents unless explicitly requested |
| `--deep-dive <name,name>` | Limit deep dives to comma-separated non-empty names |
| `--dry-run` | Inspect and propose a documentation plan without writing files |
| `--` | Start raw freeform instruction text |

Only one positional target is accepted before `--`. Unknown flags, missing flag values, empty deep-dive entries, ambiguous positional arguments, unterminated quotes, missing paths, and non-directory targets fail before a model turn.

## Runtime flow

1. `parse.ts` tokenizes quoted arguments, parses flags, resolves the target and output directory, and validates the target.
2. `index.ts` builds a normalized packet containing the resolved paths, update mode, scope, dry-run state, and instruction.
3. An idle session receives the packet immediately. A busy session queues it as a follow-up and shows a notification.
4. `prompt.md` owns model work: evidence-first inspection, documentation selection, frontmatter, diagrams, writing, and final verification.

The command supplies directory and flag completions. Output-directory completion resolves relative to the selected target. Freeform deep-dive values are not auto-completed.

## Generated documentation contract

Generated or updated Markdown files use this frontmatter:

```yaml
---
title: <document title>
summary: <1-2 sentence summary>
source_scope: <resolved target path>
generated_by: smart-docs command
generated_at: <YYYY-MM-DD>
---
```

The default set is proportional to target size:

- `1. Project Overview.md`
- `2. Architecture Overview.md`
- `3. Workflow Overview.md`
- `4. Deep Dive/` for high-value modules

Claims and Mermaid diagrams must be grounded in inspected files. Matching docs are updated instead of duplicated when update mode or auto-detection applies.

## Boundaries

- The resolved target is authoritative; the model must not reinterpret it.
- Dry-run mode performs no documentation writes.
- The resolved output directory owns generated documentation placement.
- The extension parses, validates, normalizes, and routes. It does not generate documentation itself.

## Files

- `index.ts` — command registration, completions, normalized packet, and immediate/follow-up delivery
- `parse.ts` — deterministic argument parsing and path resolution
- `prompt.md` — model-owned documentation workflow
- `index.test.ts` — routing and completion coverage
- `parse.test.ts` — grammar and validation coverage

## Registration

The command is active through `./extensions/smart-docs` in `package.json -> pi.extensions`. There is no parallel `smart-docs` skill or prompt-template entrypoint.
