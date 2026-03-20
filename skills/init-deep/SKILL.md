---
name: init-deep
description: 'Generate hierarchical AGENTS.md files for a codebase — root plus complexity-scored subdirectories. Uses concurrent explore agents, bash structural analysis, LSP codemap, and a scoring matrix to determine where documentation is actually needed. Use this skill whenever the user asks to "init-deep", "generate AGENTS.md files", "set up project context files", "create codebase documentation", "document this codebase", or "initialize deep docs". Also trigger when the user wants to update or regenerate existing AGENTS.md files across a project. Supports --create-new flag (delete all and regenerate from scratch) and --max-depth=N (default: 3).'
---

# init-deep: Hierarchical AGENTS.md Generator

Generate AGENTS.md files at the root and in complexity-worthy subdirectories. The goal: give agent precise, non-redundant context exactly where it needs it — no fluff, no generic advice.

## Args

- (default / no flag): Update mode — modify existing files, create new ones where warranted
- `--create-new`: Read all existing first (preserve context) → delete all → regenerate from scratch
- `--max-depth=N`: Limit directory depth (default: 3)

---

## Phase 1: Discovery + Analysis

**TodoWrite ALL phases first. Mark in_progress → completed in real-time.**

```
TodoWrite([
  { id: "discovery", content: "Parallel: explore agents + bash analysis + LSP codemap + read existing", status: "pending", priority: "high" },
  { id: "scoring",   content: "Score directories, decide AGENTS.md locations", status: "pending", priority: "high" },
  { id: "generate",  content: "Generate AGENTS.md files (root first, then subdirs in parallel)", status: "pending", priority: "high" },
  { id: "review",    content: "Deduplicate, validate, trim", status: "pending", priority: "medium" }
])
```

**Mark "discovery" as in_progress.**

### Launch everything in ONE response (true parallelism)

Parallel execution means calling multiple tools in the **same response message**. Call all of the following together — Agent tools, Bash tools, LSP tools — so they run concurrently. You get all results back before proceeding.

**Step 1: Measure project scale first** (single Bash call, needed to decide agent count)

```bash
total_files=$(find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | wc -l)
total_lines=$(find . -type f \( -name "*.ts" -o -name "*.py" -o -name "*.go" \) -not -path '*/node_modules/*' -exec wc -l {} + 2>/dev/null | tail -1 | awk '{print $1}')
large_files=$(find . -type f \( -name "*.ts" -o -name "*.py" \) -not -path '*/node_modules/*' -exec wc -l {} + 2>/dev/null | awk '$1 > 500 {count++} END {print count+0}')
max_depth=$(find . -type d -not -path '*/node_modules/*' -not -path '*/.git/*' | awk -F/ '{print NF}' | sort -rn | head -1)
echo "files=$total_files lines=$total_lines large=$large_files depth=$max_depth"
```

**Step 2: In a single response, call ALL of the following in parallel:**

#### Explore agents (Agent tool, subagent_type="explore")

Launch these 6 base agents. Add more based on project scale (table below).

```
Agent(subagent_type="explore", prompt="Project structure: PREDICT standard patterns for detected language → REPORT deviations only")
Agent(subagent_type="explore", prompt="Entry points: FIND main files → REPORT non-standard organization")
Agent(subagent_type="explore", prompt="Conventions: FIND config files (.eslintrc, pyproject.toml, .editorconfig) → REPORT project-specific rules only")
Agent(subagent_type="explore", prompt="Anti-patterns: FIND 'DO NOT', 'NEVER', 'ALWAYS', 'DEPRECATED' comments → LIST forbidden patterns verbatim")
Agent(subagent_type="explore", prompt="Build/CI: FIND .github/workflows, Makefile, package.json scripts → REPORT non-standard patterns")
Agent(subagent_type="explore", prompt="Test patterns: FIND test configs and test directory structure → REPORT unique conventions")
```

Scale-based additional agents (spawn in the same parallel batch):

| Factor | Threshold | Extra agents |
|--------|-----------|-------------|
| Total files | >100 | +1 per 100 files |
| Total lines | >10k | +1 per 10k lines |
| Directory depth | ≥4 | +2 for deep exploration |
| Large files (>500 lines) | >10 | +1 for complexity hotspots |
| Monorepo detected | — | +1 per package/workspace |
| Multiple languages | >1 | +1 per language |

Example for a 500-file, 50k-line, depth-6 project: spawn 5+5+2+1 = 13 additional agents covering large-file analysis, deep modules, cross-cutting utilities, etc.

#### Bash structural analysis (same parallel batch)

```bash
# Directory depth distribution
find . -type d -not -path '*/\.*' -not -path '*/node_modules/*' -not -path '*/venv/*' -not -path '*/dist/*' -not -path '*/build/*' | awk -F/ '{print NF-1}' | sort -n | uniq -c

# Files per directory (top 30)
find . -type f -not -path '*/\.*' -not -path '*/node_modules/*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -30

# Code concentration by extension
find . -type f \( -name "*.py" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.go" -o -name "*.rs" \) -not -path '*/node_modules/*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -20

# Locate existing AGENTS.md
find . -type f -name "AGENTS.md" -not -path '*/node_modules/*' 2>/dev/null
```

#### LSP codemap (same parallel batch, if LSP server is available)

Use the `LSP` tool to query the language server. Run these in parallel:

```
LSP(operation="document_symbols", file_path="src/index.ts")    # adjust to actual entry point
LSP(operation="workspace_symbols", query="class")
LSP(operation="workspace_symbols", query="interface")
LSP(operation="workspace_symbols", query="function")
```

After getting symbols, identify the top 5–10 most-exported symbols and call:
```
LSP(operation="references", file_path="...", line=N, character=N)
```

If LSP returns an error or no server is running: skip the CODE MAP section in the output; rely on explore agents and bash analysis only.

#### Read existing AGENTS.md files (same parallel batch)

Use `Read` tool for each file found. Extract: key insights, conventions, anti-patterns. If `--create-new`: read all first → then delete all → regenerate.

### After all parallel calls return

Merge results: bash structure + LSP symbols + existing files + explore agent findings.
**Mark "discovery" as completed.**

---

## Phase 2: Scoring & Location Decision

**Mark "scoring" as in_progress.**

Score each directory:

| Factor | Weight | High threshold | Source |
|--------|--------|----------------|--------|
| File count | 3x | >20 | bash |
| Subdir count | 2x | >5 | bash |
| Code ratio | 2x | >70% code files | bash |
| Unique patterns | 1x | Has own config | explore |
| Module boundary | 2x | Has index.ts / __init__.py | bash |
| Symbol density | 2x | >30 symbols | LSP |
| Export count | 2x | >10 exports | LSP |
| Reference centrality | 3x | >20 refs | LSP |

Decision rules:

| Score | Action |
|-------|--------|
| Root (.) | ALWAYS create |
| >15 | Create AGENTS.md |
| 8–15 | Create if distinct domain |
| <8 | Skip (parent covers it) |

Produce:
```
AGENTS_LOCATIONS = [
  { path: ".", type: "root" },
  { path: "src/hooks", score: 18, reason: "high complexity" },
  { path: "src/api", score: 12, reason: "distinct domain" }
]
```

**Mark "scoring" as completed.**

---

## Phase 3: Generate

**Mark "generate" as in_progress.**

**File writing rule**: Check if AGENTS.md already exists at each target path (you found them in Phase 1). If it exists → use `Edit`. If it does NOT exist → use `Write`. Never use `Write` to overwrite an existing file.

### Root AGENTS.md — write this first (sequential, before subdirs)

```markdown
# PROJECT KNOWLEDGE BASE

**Generated:** {TIMESTAMP}
**Commit:** {SHORT_SHA}
**Branch:** {BRANCH}

## OVERVIEW
{1-2 sentences: what this is + core stack}

## STRUCTURE
\`\`\`
{root}/
├── {dir}/    # {non-obvious purpose only}
└── {entry}
\`\`\`

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|

## CODE MAP
{From LSP — omit entirely if LSP was unavailable or project <10 files}

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|

## CONVENTIONS
{ONLY deviations from language/framework standard — skip section if none}

## ANTI-PATTERNS (THIS PROJECT)
{Explicitly forbidden patterns found in this codebase}

## UNIQUE STYLES
{Project-specific idioms}

## COMMANDS
\`\`\`bash
{dev / test / build}
\`\`\`

## NOTES
{Gotchas, known traps}
```

Quality gates: 50–150 lines, no generic advice, no obvious info.

### Subdirectory AGENTS.md — call all Agent tools in ONE response (parallel)

For each non-root location in AGENTS_LOCATIONS, call all Agent tools in the **same response message**:

```
Agent(subagent_type="general", prompt="""
Write AGENTS.md for: src/hooks
Reason for inclusion: high complexity (score 18)
Constraints:
- 30–80 lines max
- Never repeat anything already in root AGENTS.md
- Sections: OVERVIEW (1 line), STRUCTURE (only if >5 subdirs), WHERE TO LOOK, CONVENTIONS (only if different from root), ANTI-PATTERNS
- Use telegraphic style: dense, no filler
- Write the file directly using the Write or Edit tool
""")

Agent(subagent_type="general", prompt="""
Write AGENTS.md for: src/api
...same constraints...
""")
```

Wait for all Agent tool results to return. **Mark "generate" as completed.**

---

## Phase 4: Review & Deduplicate

**Mark "review" as in_progress.**

Read each generated file and check:
- Remove generic advice that applies to any project
- Remove content duplicated from the parent AGENTS.md
- Trim to size limits (root: ≤150 lines, subdirs: ≤80 lines)
- Verify telegraphic style

**Mark "review" as completed.**

---

## Final Report

```
=== init-deep Complete ===

Mode: {update | create-new}

Files:
  [OK] ./AGENTS.md (root, {N} lines)
  [OK] ./src/hooks/AGENTS.md ({N} lines)
  ...

Dirs analyzed:     {N}
AGENTS.md created: {N}
AGENTS.md updated: {N}

Hierarchy:
  ./AGENTS.md
  └── src/hooks/AGENTS.md
  └── src/api/AGENTS.md
```

---

## Anti-patterns to avoid

- **Sequential tool calls**: exploration agents, bash, and LSP must all fire in the same response — not one at a time
- **Fake parallelism**: "running agents while doing other work" doesn't exist — all parallel work is in one message batch
- **Static agent count**: vary agent count based on project scale, don't hardcode 6
- **Ignoring existing files**: always read existing content first, even with --create-new
- **Over-documenting**: not every directory needs AGENTS.md — use the scoring matrix
- **Redundancy**: child files must never repeat parent content
- **Generic content**: if it applies to ALL projects, cut it
- **Verbose style**: telegraphic or cut it
