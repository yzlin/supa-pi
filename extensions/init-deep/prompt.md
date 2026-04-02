Generate hierarchical `AGENTS.md` files for the resolved target codebase.

Rules:
- The target root has already been resolved by the command. Do not reinterpret target selection.
- Keep all reads, writes, edits, and deletes scoped to that target root.
- Inspect before writing. Ground claims in files you actually read.
- Prefer `find`, `grep`, `ls`, `read`, and focused `bash` over speculative reasoning.
- Use `TaskCreate` / `TaskUpdate` for multi-step tracking.
- Use telegraphic style inside generated `AGENTS.md` files.
- Do not add generic advice that applies to every repo.
- Child `AGENTS.md` files must not repeat parent guidance.
- If `create-new` is true, read existing `AGENTS.md` files in scope first, then remove them with `trash` before regenerating.
- If `dry run` is true, do not write, edit, or delete files.
- Treat the resolved `max depth` as a hard limit for nested `AGENTS.md` placement.

## Workflow

### 1. Discovery

Create tasks for:
- discovery
- scoring
- generation
- review

During discovery, inspect the target with the strongest low-cost signals first:
- top-level structure
- existing `AGENTS.md` files in scope
- build/test/config files
- entry points
- package/workspace boundaries
- directories with high file concentration

Use broad exploration only when needed:
- if the target spans multiple unfamiliar modules, launch explorer agents in parallel
- if direct file inspection is enough, stay local

Collect evidence for:
- stack and framework choices
- project-specific conventions
- anti-patterns already documented in code or docs
- major module boundaries
- directories that deserve their own `AGENTS.md`

### 2. Scoring

Score directories using repo evidence, not guesswork.

Signals that increase the chance a directory needs its own `AGENTS.md`:
- many source files
- many child directories
- distinct domain or subsystem boundary
- local config or conventions
- high symbol density or export centrality when easy to verify
- repeated traps or workflow differences from the rest of the target

Heuristic:
- root target: always gets an `AGENTS.md`
- high complexity / distinct domain: create child `AGENTS.md`
- small leaf dirs with no unique guidance: inherit from parent, skip file creation

Honor the resolved `max depth` exactly.

### 3. Generation

If not dry-run:
- write the root `AGENTS.md` first
- then create/update child `AGENTS.md` files
- use `edit` for existing files
- use `write` only for files that do not yet exist

Root file should cover:
- overview
- structure
- where to look
- conventions unique to this target
- anti-patterns unique to this target
- commands worth knowing
- high-signal gotchas

Child files should cover only local context:
- what this subtree owns
- where to look inside it
- local conventions
- local anti-patterns
- local testing/build notes when they differ from parent

Quality bar:
- dense
- specific
- evidence-backed
- no filler
- no repeated parent content

### 4. Review

Read generated or updated files and trim:
- duplicated guidance
- generic advice
- unsupported claims
- low-value directory listings

If dry-run:
- do not write files
- return the proposed file tree, rationale, and likely content focus

## Output expectations

If files are written, finish with a short summary containing:
1. resolved target
2. mode (`update` or `create-new`)
3. max depth
4. directories inspected
5. `AGENTS.md` files created, updated, or removed
6. main conventions / anti-patterns captured
7. gaps or uncertainties
