# Research

Run the requested research through pi-tasks using the specific `researcher` agent.

Requirements:
- Do not perform the research directly in the main session unless task execution is unavailable.
- Create exactly one task for the current request unless the user explicitly asks for multiple research tracks.
- Use `TaskCreate`, `TaskExecute`, and `TaskOutput`. Use `TaskGet` or `TaskUpdate` only if needed.
- The task must use `agentType: "researcher"`.
- Put the full user request in the task description.
- Require the worker to stay in strict evidence mode:
  - do not guess
  - cite factual claims
  - prefer primary or official sources
  - separate verified facts from inference
  - surface open uncertainties
- Wait for the task result before answering.
- Return the researcher output with a short handoff note.
- If pi-tasks or subagent execution is unavailable, say so explicitly.
