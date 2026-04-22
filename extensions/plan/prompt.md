# Plan

A planning workflow for investigating the request, resolving the important unknowns, and producing a high-confidence implementation plan in this session.

**Announce at start:** "Let me investigate first, then we’ll work through the plan together here."

Requirements:
- If the request includes `<request>...</request>`, ignore surrounding text and treat only the content inside that tag pair as the planning input.
- Resolve any material unknowns or spec gaps with the `questionnaire` tool before presenting the final plan.
- Keep using `questionnaire` until the plan is clear enough that additional questions would not materially change it.
- Never ask whether you should start planning or ask for approval to create the plan itself.
- Do not append `WAITING FOR CONFIRMATION: Reply with yes, no, or modify.`.
- Do not ask for plan approval in plain text or via `questionnaire`.
- If any unanswered unknowns still matter for later implementation, show them as reminders in the final plan instead of asking for confirmation.
- End the final `/plan` response after the plan. No separate confirmation turn.

---

## The Flow

```
Phase 1: Quick Investigation
    ↓
Phase 2: Clarify Unknowns (questionnaire only)
    ↓
Phase 3: Present Final Plan
    ↓
Phase 4: Include reminders for any remaining unanswered items
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

## Phase 2: Clarify Unknowns

Use the findings from Phase 1 as context. Continue in this session.

### Clarification Rules

1. If any unknown or spec gap would materially change the plan, ask about it with the `questionnaire` tool before showing the final plan.
2. Ask only 1-3 focused questions per turn.
3. Offer only meaningful choices; do not include filler options that are obviously wrong.
4. Walk down each branch of the design tree in dependency order and stop asking once the remaining uncertainty no longer materially changes the plan.
5. For any provided options, mark the recommended option and give a short reason.
6. Do not claim 100% certainty. Aim for the highest justified confidence and explicitly call out remaining assumptions.
7. Do not ask for confirmation here.

## Phase 3: Present Final Plan

When the material unknowns are resolved, present the plan in one response.

### Restate Requirements

**Goal:** Clarify what will be built.

### Identify Risks

**Goal:** Surface blockers, dependencies, and assumptions.

### Create Step Plan

**Goal:** Break implementation into clear phases with ordered steps.

## Phase 4: Include Reminders

If there are still unanswered items that do not block plan generation but should be resolved later, include a short reminders section.

- Use reminders only for genuine pending inputs, external confirmations, or unresolved details that still matter later.
- Keep reminders specific: what is still unknown, who needs to answer it, and what part of implementation it affects.
- Do not turn reminders into a confirmation request.
- If a missing answer is still material enough to change the plan, do not show the final plan yet; keep using `questionnaire` instead.

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

### Reminders
- [Only include if some answers are still pending but not material enough to block the plan]

### Estimated Complexity
[HIGH / MEDIUM / LOW with rough effort estimate]

### Confidence
[High / Medium / Low with one-line reason]

**CRITICAL**:
- Do NOT write any code in `/plan`.
- If material ambiguity remains, keep using `questionnaire` until the plan is clear enough to present.
- Never ask for `yes`, `no`, or `modify` confirmation after the plan.
- Use reminders instead of a confirmation prompt when there are still pending answers worth flagging.
