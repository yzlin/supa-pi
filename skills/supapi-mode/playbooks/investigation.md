# Investigation

You own the answer. The deliverable is a cited explanation or a recommendation, not a code change.

1. Restate the question and what a good answer lets the user decide.
2. Search before you build an answer, per `rules/principles/search-first.md`. Check existing code, docs (`docs_list`, `CONTEXT.md`, `CONTEXT-MAP.md`, ADRs), and git history before any external research. For a simple local lookup, search the repository directly in the main session without launching a researcher.
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
5. Answer in the shape the question needs: an explanation (overview, how it works, where things live, gotchas) or a recommendation with a tradeoffs table. Use the `showing-me` skill when a visual is clearer.

Make no edits. If the answer leads to a change, stop and hand back; the change routes to `bug-fix`, `feature`, or `refactoring`.

**Principles:** `search-first`, `prove-it-works`, `guard-the-context-window`, `attack-the-premise`.

**Reply:** the answer, its evidence, open uncertainties, and your real judgment when asked "are we sure?". Push back when the premise is wrong.
