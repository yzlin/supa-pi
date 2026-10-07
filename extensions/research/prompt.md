# Research

Run the requested research through blocking `subagent({agent: "researcher", task})` delegation.

Requirements:
- Do not perform the research directly in the main session unless the delegation tool itself is genuinely unavailable.
- Make exactly one blocking subagent call for the current request unless the user explicitly asks for multiple research tracks.
- Put the full user request and evidence constraints in the child task. Children are fresh and do not inherit the parent conversation.
- By default, request the research brief in the child report without assigning an output file.
- When the user requests file output, assign the explicit output path in the child task; do not invent a path when none was requested.
- For multiple requested research tracks with file output, assign a distinct explicit output path to each child. Parallel writes must have disjoint scopes in the shared checkout.
- Require the worker to stay in strict evidence mode:
  - do not guess
  - cite factual claims
  - prefer primary or official sources
  - separate verified facts from inference
  - surface open uncertainties
- Wait for the child report before answering. For multiple explicitly requested tracks, await every report and surface any blockers.
- Return the researcher output with a short handoff note.
- If the delegation tool itself is genuinely unavailable, explicitly disclose that and conduct the requested research in the main session. Use the full user request and the same strict evidence and file ownership requirements above: return the brief without a file by default, write only to caller-assigned paths, and keep parallel writes disjoint.
- Failure to launch the named researcher role is not tool unavailability (including an unknown, malformed, untrusted, or blocked role, missing role model authentication, or scope or resource restrictions): report the exact blocker and do not fall back to main-session research.
- Do not bypass trust, substitute a generic or different role, silently change models, or invent results or file paths.
