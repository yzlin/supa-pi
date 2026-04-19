# Plan

A planning workflow for investigating the request, clarifying the important branches, and producing a high-confidence implementation plan in this session.

**Announce at start:** "Let me investigate first, then we’ll work through the plan together here."

Requirements:
- If the request includes `<request>...</request>`, ignore surrounding text and treat only the content inside that tag pair as the planning input.
- Always generate and present a concrete first-pass plan before asking for approval.
- Never ask whether you should start planning or ask for approval to create the plan itself.
- Approval is only for whether to proceed with implementation after the plan has been shown.
- In the initial `/plan` response, do not call `questionnaire` or any other tool after drafting the plan. Tool calls run before the final assistant text is shown, which would put the approval UI before the plan.
- End the initial `/plan` response with a plain-text request for the user to reply `yes`, `no`, or `modify`.

---

## The Flow

```
Phase 1: Quick Investigation
    ↓
Phase 2: Clarify + Plan (interactive in this session)
```

---

## Phase 1: Quick Investigation

**If deeper context is needed** (large codebase, unfamiliar architecture, or unclear constraints), spawn an autonomous explorer subagent first:

```typescript
Agent({
  subagent_type: "explorer",
  prompt: "Analyze the codebase. Map file structure, key modules, patterns, and conventions. Summarize only the findings that matter for planning this task.",
  description: "Explore codebase for planning context",
  thinking: "medium"
})
```

Read the explore summary before proceeding. Summarize the relevant findings briefly before asking planning questions.

---

## Phase 2: Clarify + Plan

## Your Task

Use the findings from Phase 1 as context. Continue in this session.

### Restate Requirements

**Goal:** Clarify what needs to be built.

1. Generate a first-pass plan in the same response before asking for approval.
2. In the initial `/plan` response, do not use the `questionnaire` tool. If ambiguity remains, present the best justified first-pass plan with explicit assumptions instead of blocking on questions.
3. On later turns, use the `questionnaire` tool only for ambiguities that materially change the plan, confirm an assumption, or choose between meaningful tradeoffs.
4. Ask only 1-3 focused questions per turn.
5. Offer only meaningful choices; do not include filler options that are obviously wrong.
6. Clarifying questions should refine the presented plan, not block initial plan generation.
7. Walk down each branch of the design tree in dependency order, resolve decisions one-by-one, and stop asking once additional questions would no longer materially change the plan.
8. For any provided options, mark the recommended option and give a short reason.
9. Do not claim 100% certainty. Aim for the highest justified confidence and explicitly call out remaining unknowns or assumptions.

### Identify Risks

**Goal:** Surface potential issues, blockers, dependencies, and assumptions.

### Create Step Plan

**Goal:** Break implementation into clear phases with ordered steps.

### Wait for Confirmation

**Goal:** MUST receive user approval after presenting the plan and before any code is written.

In the initial `/plan` response, ask for confirmation in plain text at the end of the plan: `Reply with yes / no / modify.`

Only consider using the `questionnaire` tool on a later turn if the user responds ambiguously and structured follow-up is still materially useful.

## Output Format

### Requirements Restatement
[Clear, concise restatement of what will be built]

### Investigation Findings
[Only the findings that materially influence the plan]

### Implementation Phases
[Phase 1: Description]
- Step 1.1
- Step 1.2
...

[Phase 2: Description]
- Step 2.1
- Step 2.2
...

### Dependencies
[List external dependencies, APIs, services, migrations, approvals, or environment needs]

### Risks
- HIGH: [Critical risks that could block implementation]
- MEDIUM: [Moderate risks to address]
- LOW: [Minor concerns]

### Assumptions / Unknowns
- [Assumption or unresolved point]

### Estimated Complexity
[HIGH / MEDIUM / LOW with rough effort estimate]

### Confidence
[High / Medium / Low with one-line reason]

**WAITING FOR CONFIRMATION**: Reply with `yes`, `no`, or `modify`.

**CRITICAL**:
- Do NOT write any code until the user explicitly confirms with `yes`, `proceed`, or a similar affirmative response.
- End the initial `/plan` response after the plan and the confirmation line above. Do not call `questionnaire` in that same turn.
