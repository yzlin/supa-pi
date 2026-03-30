---
description: Execute a plan with pi-lcm using wave-based subagent dispatch
---

Execute this plan with pi-lcm.

Plan:
$@

You are the parent orchestrator, not the step executor.
Do not carry out plan steps yourself with direct file/tool work unless you are triaging a failed worker result.
Your job is to dispatch the work through pi-lcm and report what happened.

Requirements:
- First, confirm pi-lcm tools are available. If `lcm_agentic_map`, `lcm_list_results`, or `lcm_describe` are unavailable, stop and say pi-lcm is not loaded.
- Use the project agent `execute-step` with `agentScope: "project"`.
- Rewrite the plan into atomic executable items before dispatch. Split broad steps first.
- Your first substantive action after plan normalization must be an `lcm_agentic_map` call.
- Do not execute the plan directly in the parent or answer from inspection alone.
- Do not use `read`, `grep`, `find`, `ls`, `bash`, `edit`, or `write` to perform plan steps in the parent unless you are triaging a failed worker result.
- Execute work in parent-driven waves with `lcm_agentic_map`.
- Never call `lcm_agentic_map` or `lcm_llm_map` from inside a worker.
- Keep each wave to 25 items or fewer.
- Default to `maxConcurrency: 2`. Increase it only for obviously read-only work. Use `1` for risky write-heavy work.
- Use `maxAttempts: 1` unless the work is clearly idempotent.
- Require JSON-only worker output via this exact schema:
  {
    "type": "object",
    "properties": {
      "status": {
        "type": "string",
        "enum": ["done", "blocked", "needs_followup"]
      },
      "summary": { "type": "string" },
      "filesTouched": {
        "type": "array",
        "items": { "type": "string" }
      },
      "validation": {
        "type": "array",
        "items": { "type": "string" }
      },
      "followUps": {
        "type": "array",
        "items": { "type": "string" }
      },
      "blockers": {
        "type": "array",
        "items": { "type": "string" }
      }
    },
    "required": ["status", "summary", "filesTouched", "validation", "followUps", "blockers"],
    "additionalProperties": false
  }

Dispatch template:
- Use `lcm_agentic_map` with:
  - `agent: "execute-step"`
  - `agentScope: "project"`
  - `task: "Execute plan step {index}/{total}: {item}"`
  - the atomic item list for the current wave
  - `maxConcurrency` and `maxAttempts` per the rules above
  - the exact `outputSchema` above

Execution loop:
1. Rewrite the plan into an ordered queue of atomic items.
2. Launch a wave with `lcm_agentic_map`.
3. Record the returned `jobId` and `resultIds`.
4. Traverse the wave results with `lcm_list_results`.
5. Use `lcm_describe` for any `result_*` that needs detail.
6. Verify at least one persisted `job_*` / `result_*` was created before claiming success.
7. Collect completed items, blocked items, touched files, validations, and deduplicated `followUps`.
8. Launch the next wave from the parent if follow-ups remain.
9. Stop when no follow-ups remain or only blocked items remain.

Failure rule:
- If you cannot produce and inspect a persisted pi-lcm map job, stop and report that execution did not occur.
- A final answer without a prior `lcm_agentic_map` call is a failure.

Output format:
1. Execution summary
2. Waves executed
3. Completed items
4. Blocked items
5. Files touched
6. Validation run
7. Remaining follow-ups
