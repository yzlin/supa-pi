---
name: context-docs
description: "Use for durable project context workflows: /context-setup, /context-note, /adr, /context-review, CONTEXT.md, CONTEXT-MAP.md, ADRs, context extraction, or turning session knowledge into persistent docs. Do not use for execution-ledger or goal-checkpoint management."
---

# Context Docs

Canonical instructions for creating and reviewing durable project context. The resolved extension input is authoritative for command, target root, instruction, and options.

## Documentation and codemap safeguards

For README, guide, codemap, or durable context changes, load and follow the [Documentation and codemap safeguards](references/documentation-safeguards.md) reference as part of this workflow.

## Commands

- `/context-setup [target] [--dry-run] [--force] -- [instructions]`
- `/context-note [target] [--title <title>] [--tags a,b] -- <note>`
- `/adr [target] [--title <title>] [--status proposed|accepted|superseded|deprecated|rejected] -- <decision>`
- `/context-review [target] [--dry-run] [--scope current|all] -- [focus]`

## Durable file scope

Prefer Matt-compatible root files unless the target already has stronger conventions:

- `CONTEXT.md` — broad human-readable product and domain context: purpose, domain model, glossary, product constraints, open questions, and a pointer to the context map.
- `CONTEXT-MAP.md` — real durable-context boundaries, ADR locations, and explicit guidance for when agents should read referenced docs.
- `docs/adr/` — Architecture Decision Records for tradeoff decisions.
- `docs/context/` — optional longer durable notes when root context files would become too large.
- managed `AGENTS.md` sections — project-specific agent conventions that alter how future agents work.

Preserve existing style, filenames, numbering, frontmatter, and stronger local conventions. Use explicit map instructions such as “read `docs/auth.md` before changing authentication, sessions, or user identity.” Keep files concise and source-grounded.

## Domain modeling

`domain-modeling` is the sole semantic owner. Delegate semantic analysis to `domain-modeling` when the evidence includes vocabulary that needs sharpening, scenario-dependent domain claims, code and durable docs contradict, real ownership, integration, lifecycle, or trust boundaries, or possible ADR candidacy. Do not invoke it for ordinary documentation work without one of those signals.

If another skill hands context-docs a completed domain-modeling packet, consume it without invoking `domain-modeling` again. Context-docs remains the sole persistence authority: classify and route the packet, ask only questions needed for an accurate durable record, and perform any permitted writes. Persist each resolved glossary entry with its canonical term, its concise definition, and its `_Avoid_` aliases; preserve unknowns rather than inventing certainty.

## Setup

Create or refresh the context-doc scaffold. Update existing files in place. If absent, create concise root files with these shapes:

```markdown
# CONTEXT

## Product purpose

## Domain model

## Domain glossary

## Product constraints

## Open questions

## Context map

See `CONTEXT-MAP.md`.
```

```markdown
# CONTEXT-MAP

## Read first

- `CONTEXT.md` — domain/product overview, glossary, constraints, and open questions.

## Architecture decisions

- `docs/adr/` — proposed, accepted, superseded, deprecated, or rejected tradeoff decisions.

## Context notes

- `docs/context/` — longer durable notes that should not live in chat only.

## Maintenance rules

- List cross-cutting docs with plain-language guidance for when agents should read them.
- Keep entries stable, source-grounded, and small.
```

Keep setup focused on scaffold and map boundaries. With `--dry-run`, report planned changes only. Treat `--force` as permission for broader scaffold refreshes, not unrelated rewrites.

## Note classification and routing

Record only durable, project-specific context, including domain vocabulary, product or implementation conventions, real module boundaries and ownership, integration contracts, target-specific workflow rules, resolved implementation details likely to matter later, and unresolved questions with a clear owner or next trigger.

Challenge or reject transient progress, generic advice, raw logs without a durable takeaway, secrets or sensitive data, and task-management instructions.

Route domain and product language to `CONTEXT.md`; agent conventions to a managed section in `AGENTS.md`; real cross-cutting boundaries to `CONTEXT-MAP.md`; and detailed durable notes to a targeted file under `docs/context/`. Update `CONTEXT-MAP.md` only for real durable-context boundaries or new cross-cutting files. Fail safely rather than duplicating a malformed managed `AGENTS.md` block.

## ADR

Create or update an ADR under `docs/adr/` unless the target has another ADR convention. Use a stable lowercase hyphenated filename; without a numbering convention, prefer `docs/adr/YYYY-MM-DD-short-title.md`.

Use `summary` and `read_when` frontmatter so `docs_list` can route the ADR, followed by the full ADR format:

```markdown
---
summary: "<one-sentence decision summary>"
read_when:
  - "<conditions that should route future agents to this ADR>"
---

# ADR: <title>

- Status: proposed | accepted | superseded | deprecated | rejected
- Date: YYYY-MM-DD
- Deciders: unknown unless provided
- Supersedes: none unless known
- Superseded by: none unless known

## Context

## Decision

## Consequences

## Alternatives considered
```

Capture the tradeoff and rationale, not a generic essay. Default status to `proposed`. Use the current date, mark unknown facts explicitly, and preserve context, decision, consequences, and alternatives. Use the ADR-candidacy results supplied by `domain-modeling`: when all three canonical results are `yes`, writing is permitted; when any result is `unknown`, ask one focused question for the missing evidence; when any result is `no`, refuse to write the ADR and explain why. If rationale is missing, ask one focused question before writing an accepted ADR. When one ADR replaces another, update both safely when possible.

## Review extraction

Read, when present, `CONTEXT.md`, `CONTEXT-MAP.md`, `AGENTS.md`, map-referenced docs, `docs/adr/`, and relevant README files. With `--scope current`, focus on that set and direct references; with `--scope all`, scan broader repository docs for supporting or contradictory evidence.

Extract only source-grounded durable context: product purpose and constraints; domain terms and definitions; architecture boundaries and ownership; proposed or accepted tradeoff decisions and rationale; agent conventions routed to managed `AGENTS.md`; integration contracts and external dependencies; stale, contradictory, or missing docs; and open questions that block accurate documentation.

Exclude secrets, credentials, raw private data, pi-task state, generic advice, transient progress, temporary debugging output without a durable lesson, unverified memory, and unnecessarily stale-prone code snippets. Report contradictions before editing. With `--dry-run`, report findings and proposed edits only; otherwise make the smallest edits that preserve existing structure.

### Doc-reference drift with codemode

When the `codemode` tool is available, inventory review docs and check backticked repo-relative path references in one script to save main-context space. Set `root` and `scope` from the resolved command input. This scans root context files and ADRs; `--scope all` also includes context notes and READMEs referenced by the context map. Only file paths, line counts, and missing references reach the main thread.

```js
// @options: {"max_output_tokens": 2000}
const root = "<resolved target root>", scope = "current";
const q = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const bash = async (command) => {
  const r = await tools.bash({ reasoning: "context-review doc-reference drift", command: `cd ${q(root)} && ${command}` });
  if (r.exit_code !== 0 || r.truncated) throw new Error("Incomplete doc-reference scan; narrow the batch or read full output");
  return r.output;
};
const listed = await bash(`for p in CONTEXT.md CONTEXT-MAP.md AGENTS.md docs/adr/*.md ${scope === "all" ? "docs/context/*.md" : ""}; do if test -f "$p"; then printf '%s\\n' "$p"; fi; done`);
const paths = listed.trim() ? listed.trim().split("\n") : [], docs = [], refs = [];
for (const path of paths) {
  const read = await bash(`if test -f ${q(path)}; then printf '1'; cat -- ${q(path)}; fi`);
  if (!read) continue;
  const text = read.slice(1);
  docs.push({ path, lines: text ? text.split(/\r?\n/).length - Number(text.endsWith("\n")) : 0 });
  for (const ref of new Set([...text.matchAll(/`([^`\r\n]+)`/g)].map((m) => m[1]))) {
    if (!/^[\w.-]+(?:\/[\w.-]+)*\/?$/.test(ref) || ref.split("/").includes("..")) continue;
    if (!ref.includes("/") && !/\.[a-zA-Z0-9]+$/.test(ref)) continue;
    refs.push({ doc: path, ref });
    if (scope === "all" && path === "CONTEXT-MAP.md" && /(^|\/)README\.md$/i.test(ref) && !paths.includes(ref)) paths.push(ref);
  }
}
const unique = [...new Set(refs.map(({ ref }) => ref))];
const absent = await bash(`for p in ${unique.map(q).join(" ")}; do if ! test -e "$p"; then printf '%s\\n' "$p"; fi; done`);
const missing = new Set(absent.trim() ? absent.trim().split("\n") : []);
return { docs, missing: refs.filter(({ ref }) => missing.has(ref)) };
```

- The script only inventories and checks existence; it does not decide contradictions or durable content. It conservatively accepts plain paths, skipping URLs, globs, placeholders such as `<...>`, and shell commands.
- Read full doc contents in the main thread only when extraction needs them.
- Respect `--dry-run`; this script is read-only. Missing references are findings to report, not auto-fix.
- Nested calls use the tool's declared arguments and the same validation and hooks as direct calls. Do not treat failed or truncated reads as a complete scan.

## Output

Summarize files read, files changed, decisions captured, open questions, and validation performed.
