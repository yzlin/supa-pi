---
title: init-deep extension command spec
read_when:
  - implementing /init-deep as an extension command
  - changing init-deep command syntax or migration behavior
status: draft
---

# `/init-deep` extension command spec

Goal: replace the prompt-only `init-deep` skill with a deterministic `/init-deep` extension command that parses scope and flags in code, then injects a normalized prompt for the model.

## Why

The old skill already behaves like a command:
- optional target path
- `--create-new`
- `--max-depth=N`
- a rigid multi-phase workflow

Problems with leaving parsing in markdown:
- model must infer flags from prose
- model must decide whether the first token is a path or instruction
- destructive regeneration mode is easier to trigger accidentally
- future flags get harder to add safely

Extension command fixes that by resolving inputs before the model sees them.

## User-facing syntax

Supported forms:

```text
/init-deep
/init-deep <target>
/init-deep --create-new
/init-deep --max-depth 2
/init-deep --max-depth=2
/init-deep <target> [flags]
/init-deep <target> [flags] -- <instruction>
```

Examples:

```text
/init-deep
/init-deep ./packages/foo
/init-deep --create-new
/init-deep ./packages/foo --max-depth 2
/init-deep ./packages/foo --max-depth=2 --create-new
/init-deep ./packages/foo --dry-run -- focus on runtime and extension boundaries
```

## Deterministic grammar

Rules:
1. Parse flags first.
2. Treat the first non-flag positional token before `--` as `target`.
3. Treat everything after `--` as raw `instruction`.
4. Reject a second positional token before `--`.
   - User must write `/init-deep <target> -- <instruction>`.
5. If no `target` is present, use the current working directory.
6. If no `instruction` is present, use the default init-deep workflow.
7. Accept both `--max-depth <n>` and `--max-depth=<n>`.

## Flags

| Flag | Type | Default | Meaning |
|---|---|---:|---|
| `--create-new` | boolean | false | Read existing AGENTS.md files, then regenerate from scratch |
| `--max-depth <n>` | integer | 3 | Maximum nested directory depth to consider |
| `--dry-run` | boolean | false | Analyze and propose AGENTS.md locations/changes without writing |

## Parsed command shape

```ts
interface InitDeepCommandInput {
  targetRoot: string;
  targetLabel: string;
  instruction: string | null;
  createNew: boolean;
  maxDepth: number;
  dryRun: boolean;
}
```

## Validation

Validate before sending any prompt:

1. `targetRoot` exists
2. `targetRoot` is a directory
3. `maxDepth` is a positive integer
4. reject unknown flags
5. reject multiple positional args before `--`

Error style:
- short
- actionable
- no model turn

Examples:
- `Target path does not exist: ./packages/missing`
- `Invalid --max-depth value: zero. Use a positive integer.`
- `Ambiguous arguments. Use '/init-deep <target> -- <instruction>' to pass freeform instructions.`

## Command behavior

Handler flow:

1. Parse args
2. Validate args
3. Build normalized prompt text from `prompt.md`
4. If agent idle: `pi.sendUserMessage(message)`
5. If agent busy: `pi.sendUserMessage(message, { deliverAs: "followUp" })`
6. Notify user when queued as follow-up

Do not implement AGENTS generation in the extension itself.
The extension only:
- parses
- validates
- normalizes
- routes

The model still performs repo inspection and file edits.

## Prompt handoff contract

Store the actual generation instructions in `extensions/init-deep/prompt.md`.
The extension injects a normalized prelude before that prompt.

Generated message shape:

```md
Generate hierarchical AGENTS.md files for the resolved target codebase.

Resolved command input:
- target root: <absolute path>
- target label: <original path or ".">
- mode: <update|create-new>
- max depth: <n>
- dry run: <true|false>
- instruction: <text or default>

Command rules:
- The target root above is already resolved. Do not reinterpret it.
- Keep reads/writes/deletes scoped to that target root.
- If create-new is true, read existing AGENTS.md files first, then remove them with `trash` before regenerating.
- If dry run is true, inspect and propose changes only.
- The max depth above is a hard limit.

<contents of prompt.md>
```

## `prompt.md` responsibilities

`prompt.md` should keep only model work:
- inspect before write
- score directories
- generate root and child AGENTS.md files
- deduplicate
- validate results
- summarize findings

`prompt.md` should not contain parser logic.
That belongs in the extension.

## Autocomplete

Nice-to-have for v1:
- suggest flags from `getArgumentCompletions()`
- suggest `--` when a target path is already present
- suggest small integer values after `--max-depth`
- suggest directory path completions for the target

## File layout

```text
extensions/init-deep/
  README.md
  index.ts
  prompt.md
  parse.ts
  parse.test.ts
  index.test.ts
```

## Migration plan

Current state:
- `skills/init-deep/SKILL.md` exists
- parsing and workflow live together in one markdown file

Recommended migration:
1. implement extension command
2. verify `/init-deep` parser and routing behavior
3. move workflow instructions into `extensions/init-deep/prompt.md`
4. remove `skills/init-deep/SKILL.md` to avoid duplicate entry points
5. add `./extensions/init-deep` to `package.json -> pi.extensions`

Why remove the skill after implementation:
- command parsing is now deterministic
- keeping both entry points adds duplication and drift risk
- destructive regeneration mode should have one canonical interface

## Acceptance criteria

The extension is ready when:
- `/init-deep` works with cwd default
- `/init-deep <target>` resolves target deterministically
- `/init-deep --max-depth=<n>` and `/init-deep --max-depth <n>` both work
- bad input fails fast without invoking the model
- busy-session behavior queues follow-up safely
- the old skill entry point is removed
