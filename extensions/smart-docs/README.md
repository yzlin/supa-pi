---
title: smart-docs extension command spec
read_when:
  - implementing /smart-docs as an extension command
  - changing smart-docs command syntax or migration behavior
status: draft
---

# `/smart-docs` extension command spec

Goal: replace the prompt-template-only `/smart-docs` with a deterministic extension command that parses target/scope in code, then injects a normalized prompt to the model.

Not implemented here. This doc is the source of truth for implementation.

## Why

Current prompt template works, but target parsing is heuristic.

Problems:
- model must infer whether args contain a path
- model must split target path from freeform instruction
- errors happen late
- future flags will make prompt parsing messy

Extension command fixes that by resolving inputs before the model sees them.

## User-facing syntax

Supported forms:

```text
/smart-docs
/smart-docs <target>
/smart-docs -- <instruction>
/smart-docs <target> -- <instruction>
/smart-docs <target> [flags] -- <instruction>
/smart-docs [flags]
```

Examples:

```text
/smart-docs
/smart-docs ./packages/foo
/smart-docs -- focus on architecture and workflows
/smart-docs ./packages/foo -- focus on auth and API boundaries
/smart-docs ./packages/foo --out docs/architecture --overview-only
/smart-docs --update
```

## Deterministic grammar

Rules:
1. Parse flags first.
2. Treat the first non-flag positional token before `--` as `target`.
3. Treat everything after `--` as raw `instruction`.
4. Reject a second positional token before `--`.
   - Reason: avoid ambiguous parsing like `packages/foo auth`.
   - User must write `/smart-docs packages/foo -- auth`.
5. If no `target` is present, use the current working directory.
6. If no `instruction` is present, use the default documentation instruction.

This is the core determinism win: one parse path, no LLM guessing.

## Flags

Initial flags:

| Flag | Type | Default | Meaning |
|---|---|---:|---|
| `--out <dir>` | path | `docs` relative to target root | Output directory |
| `--update` | boolean | auto | Prefer updating existing docs in place |
| `--overview-only` | boolean | false | Generate only overview docs, skip deep dives |
| `--deep-dive <csv>` | string | empty | Limit deep-dive docs to named modules/components |
| `--dry-run` | boolean | false | Analyze and propose doc plan, but do not write files |

Notes:
- `--update` is a preference signal. If omitted, implementation uses auto behavior: update when docs already exist, otherwise create.
- `--deep-dive auth,db,api` is a comma-separated allowlist.
- `--out` may be relative to target root or absolute.

Deferred flags for later, not v1:
- `--front-matter-template`
- `--max-files`
- `--diagram-level`
- `--json`

## Parsed command shape

Normalized object passed into prompt builder:

```ts
interface SmartDocsCommandInput {
  targetRoot: string;           // absolute normalized path
  targetLabel: string;          // original user-facing path or "."
  outputDir: string;            // absolute normalized path
  instruction: string | null;   // raw text after `--`
  update: boolean | null;       // null = auto
  overviewOnly: boolean;
  deepDive: string[];
  dryRun: boolean;
}
```

## Validation

Validate before sending any prompt:

1. `targetRoot` exists
2. `targetRoot` is a directory
3. `outputDir` is resolvable
4. `--deep-dive` entries are non-empty after trimming
5. reject unknown flags
6. reject multiple positional args before `--`

Error style:
- short
- actionable
- no model turn

Examples:
- `Target path does not exist: ./packages/missing`
- `Ambiguous arguments. Use '/smart-docs <target> -- <instruction>' to pass freeform instructions.`
- `Unknown flag: --overview`

## Command behavior

Handler flow:

1. Parse args
2. Validate args
3. Build normalized prompt text from `prompt.md`
4. If agent idle: `pi.sendUserMessage(message)`
5. If agent busy: `pi.sendUserMessage(message, { deliverAs: "followUp" })`
6. Notify user when queued as follow-up

Do not implement docs generation in the extension itself.
The extension only:
- parses
- validates
- normalizes
- routes

The model still performs repo inspection and file edits.

## Prompt handoff contract

Store the actual generation instructions in `extensions/smart-docs/prompt.md`.
The extension injects a normalized prelude before that prompt.

Proposed generated message shape:

```md
Generate comprehensive codebase documentation.

Resolved command input:
- target root: <absolute path>
- output dir: <absolute path>
- instruction: <text or "default comprehensive documentation for target codebase">
- update mode: <auto|update>
- overview only: <true|false>
- deep dive allowlist: <csv or "all relevant modules">
- dry run: <true|false>

Command rules:
- The target root above is already resolved. Do not reinterpret it.
- If dry run is true, inspect and propose docs to create/update, but do not write files.
- If overview only is true, skip deep-dive docs unless the user explicitly asked for them.
- If deep dive allowlist is present, limit deep-dive docs to those areas.
- Prefer updating existing docs in place when update mode is update or when matching docs already exist.

<contents of prompt.md>
```

Key rule: once the extension resolves the target, the prompt must explicitly tell the model **not to reinterpret target selection**.

## `prompt.md` responsibilities

`prompt.md` should keep only model work:
- inspect before write
- evidence-first documentation
- front matter schema
- overview/architecture/workflow/deep-dive expectations
- Mermaid guidance
- finish summary

`prompt.md` should not contain parser logic.
That belongs in the extension.

## Autocomplete

Nice-to-have for v1:
- suggest flags from `getArgumentCompletions()`
- suggest `--` when one positional target is already present

Nice-to-have for v2:
- filesystem path completions for the target positional arg
- module-name suggestions for `--deep-dive`

## File layout

Planned layout:

```text
extensions/smart-docs/
  README.md          # this spec
  index.ts           # registerCommand("smart-docs", ...)
  prompt.md          # normalized generation prompt
  parse.ts           # argv parsing + validation
  parse.test.ts      # parser tests
```

## Implementation outline

### `index.ts`

Responsibilities:
- load `prompt.md`
- register `/smart-docs`
- parse args
- validate
- build normalized message
- send immediate or follow-up user message

Pseudo-shape:

```ts
pi.registerCommand("smart-docs", {
  description: "Generate codebase docs for cwd or a target path",
  getArgumentCompletions(prefix) {
    // optional flag completions
  },
  handler: async (args, ctx) => {
    const parsed = parseSmartDocsArgs(args, process.cwd());
    if (!parsed.ok) {
      ctx.ui.notify(parsed.error, "warning");
      return;
    }

    const message = buildSmartDocsMessage(parsed.value, PROMPT);
    if (ctx.isIdle()) {
      pi.sendUserMessage(message);
      return;
    }

    pi.sendUserMessage(message, { deliverAs: "followUp" });
    ctx.ui.notify("Queued /smart-docs as a follow-up", "info");
  },
});
```

### `parse.ts`

Responsibilities:
- split tokens around `--`
- parse boolean and value flags
- allow at most one positional `target`
- normalize relative paths
- compute absolute `targetRoot` + `outputDir`
- return typed result or actionable error

## Tests

Minimum parser coverage:

```text
/smart-docs
/smart-docs ./packages/foo
/smart-docs -- architecture only
/smart-docs ./packages/foo -- architecture only
/smart-docs ./packages/foo --out docs/arch
/smart-docs --out docs --overview-only
/smart-docs foo bar                # reject, ambiguous
/smart-docs --unknown             # reject
/smart-docs ./missing             # reject if path missing
/smart-docs ./packages/foo --deep-dive auth,db,api
```

Minimum command behavior coverage:
- idle session sends immediate user message
- busy session queues follow-up
- invalid parse shows warning and sends nothing

## Migration plan

Current state:
- `prompts/smart-docs.md` exists
- no `smart-docs` skill remains

Recommended migration:
1. implement extension command
2. verify `/smart-docs` extension command behavior
3. remove `prompts/smart-docs.md` to avoid duplicate entry points and user confusion
4. add `./extensions/smart-docs` to `package.json -> pi.extensions`

Why remove the prompt after implementation:
- extension commands run before prompt-template expansion
- keeping both with the same name adds discoverability noise
- parser logic should live in one place

## Non-goals

Not in v1:
- generating docs without LLM help
- custom tool for doc generation
- automatic repo-specific templates
- multi-target batch docs in one command
- CI/report JSON output

## Acceptance criteria

The extension is ready when:
- `/smart-docs` works with cwd default
- `/smart-docs <target>` resolves target deterministically
- `/smart-docs <target> -- <instruction>` separates target from instruction deterministically
- bad input fails fast without invoking the model
- busy-session behavior queues follow-up safely
- prompt builder no longer contains target-parsing heuristics
