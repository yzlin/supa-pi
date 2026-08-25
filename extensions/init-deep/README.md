---
title: init-deep extension command
read_when:
  - changing /init-deep command syntax, routing, or AGENTS.md generation behavior
status: active
---

# `/init-deep`

`/init-deep` deterministically resolves a target and command options, then asks the main agent to inspect that target and generate a scoped hierarchy of `AGENTS.md` files.

## Syntax

```text
/init-deep
/init-deep <target>
/init-deep [<target>] --create-new
/init-deep [<target>] --max-depth <n>
/init-deep [<target>] --max-depth=<n>
/init-deep [<target>] --dry-run
/init-deep [<target>] [flags] -- <instruction>
```

Defaults:

- target: current working directory
- mode: update
- maximum depth: `3`
- dry run: false
- instruction: default hierarchical `AGENTS.md` generation

Flags:

| Flag | Meaning |
|---|---|
| `--create-new` | Read existing in-scope `AGENTS.md` files, remove them with `trash`, then regenerate |
| `--max-depth <n>` / `--max-depth=<n>` | Set a positive maximum nested-directory depth |
| `--dry-run` | Inspect and propose changes without writing, editing, or deleting |
| `--` | Start raw freeform instruction text |

Only one positional target is accepted before `--`. Unknown flags, invalid depth values, ambiguous positional arguments, unterminated quotes, missing paths, and non-directory targets fail before a model turn.

## Runtime flow

1. `parse.ts` tokenizes quoted arguments, parses flags, resolves the target, and validates it.
2. `index.ts` builds a normalized command packet containing the resolved target, mode, depth, dry-run state, and instruction.
3. An idle session receives the packet immediately. A busy session queues it as a follow-up and shows a notification.
4. `prompt.md` owns model work: discovery, directory scoring, generation, deduplication, and review.

The command supplies directory and flag completions. `--max-depth` suggests values `1` through `6`; other positive integers remain valid.

## Boundaries

- The resolved target is authoritative; the model must not reinterpret it.
- All reads and mutations stay inside that target.
- Child `AGENTS.md` files contain only subtree-specific guidance and must not repeat parent guidance.
- The model uses `TaskCreate` and `TaskUpdate` for the multi-phase workflow.
- The extension parses, validates, normalizes, and routes. It does not generate files itself.

## Files

- `index.ts` — command registration, completions, normalized packet, and immediate/follow-up delivery
- `parse.ts` — deterministic argument parsing and target validation
- `prompt.md` — model-owned generation workflow
- `index.test.ts` — routing, packet, and completion coverage
- `parse.test.ts` — grammar and validation coverage

## Registration

The command is active through `./extensions/init-deep` in `package.json -> pi.extensions`. There is no parallel `init-deep` skill or prompt-template entrypoint.
