# Investigation

You own the answer. The deliverable is a cited explanation or a recommendation, not a code change.

1. Restate the question and what a good answer lets the user decide.
2. Search before you build an answer, per `rules/principles/search-first.md`. Check existing code, docs (`docs_list`, `CONTEXT.md`, `CONTEXT-MAP.md`, ADRs), and git history before any external research. For a simple local lookup, search the repository directly in the main session without launching a researcher.
   For a "how does X work" question, size it first. A narrow question (one module, one function, one flag) stays in the main session: read the code and its tests directly. A subsystem across several files, processes, or packages gets 2–4 `explorer` children in parallel in one tool block, each on a distinct slice (for example entry point and wiring, the core flow, data and storage, boundaries and failure paths). Each task names the question, its slice, "other explorers cover other slices; go deep on yours", and asks for: components with file paths, the flow step by step with the data passed, boundaries, non-obvious behavior, files read, and open questions. You merge the slices yourself: resolve overlaps and contradictions by reading the code, and open every cited location before you report it. When in doubt, stay in the main session. Either way, state the size and the reason in one line before you read, for example "Size: subsystem (3 directories), 3 explorers" or "Size: narrow (one file), main session".
   For a "why is it shaped this way" question about code, a rule, or a decision, load the `why` skill and follow it as canonical; it owns the git-history search and the evidence tiers.
3. Route external facts through the `research-mode` skill. Delegate broad or parallel reading to the `explorer` or `researcher` agent with the `subagent` tool; keep summaries, not raw payloads, in the main thread.
   The main session owns research dispatch. Dispatch the researcher only after the local checks fail to meet the requirements. It is a blocking call to a fresh task-only child, so include every needed fact; by default it returns a brief and writes no file:

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
4. Verify every claim you report against a file, command output, or cited source you read this session. Label inferences and unknowns.
5. Answer in the shape the question needs: an explanation (overview, key concepts, how it works, where things live, gotchas; drop a section that has nothing, and name the explorers' open questions instead of hiding them) or a recommendation with a tradeoffs table. Use the `showing-me` skill when a visual is clearer.

Make no edits. If the answer leads to a change, stop and hand back; the change routes to `bug-fix`, `feature`, or `refactoring`.

**Principles:** `search-first`, `prove-it-works`, `guard-the-context-window`, `attack-the-premise`.

**Reply:** the answer, its evidence, open uncertainties, and your real judgment when asked "are we sure?". Push back when the premise is wrong.
