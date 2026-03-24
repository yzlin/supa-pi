# Plan

A planning workflow for investigating the request, clarifying the important branches, and producing a high-confidence implementation plan in this session.

**Announce at start:** "Let me investigate first, then we’ll work through the plan together here."

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

1. Use the `questionnaire` tool to clarify ambiguities in the user request up front.
2. Every question must materially change the plan, confirm an assumption, or choose between meaningful tradeoffs.
3. Ask only 1-3 focused questions per turn.
4. Offer only meaningful choices; do not include filler options that are obviously wrong.
5. Interview me relentlessly about every aspect of this plan until we reach a shared understanding — but do it efficiently. Walk down each branch of the design tree in dependency order, resolve decisions one-by-one, and stop asking once additional questions would no longer materially change the plan.
6. For any provided options, mark the recommended option and give a short reason.
7. Do not claim 100% certainty. Aim for the highest justified confidence and explicitly call out remaining unknowns or assumptions.

### Identify Risks

**Goal:** Surface potential issues, blockers, dependencies, and assumptions.

### Create Step Plan

**Goal:** Break implementation into clear phases with ordered steps.

### Wait for Confirmation

**Goal:** MUST receive user approval before proceeding.

Use the `questionnaire` tool to ask for confirmation `[yes / no / modify]` on the plan before any code is written.

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

**WAITING FOR CONFIRMATION**: Proceed with this plan? (`yes` / `no` / `modify`)

**CRITICAL**: Do NOT write any code until the user explicitly confirms with `yes`, `proceed`, or a similar affirmative response.
