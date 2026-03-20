# Plan

A planning workflow that offloads brainstorming and plan creation to a dedicated interactive subagent, keeping the main session clean for orchestration.

**Announce at start:** "Let me investigate first, then I'll open a dedicated planning session where we can work through this together."

---

## The Flow

```
Phase 1: Quick Investigation (main session)
    ↓
Phase 2: Plan (interactive — user collaborates here)
```

---

## Phase 1: Quick Investigation

**If deeper context is needed** (large codebase, unfamiliar architecture), spawn an autonomous explore subagent first:

```typescript
Agent({
  subagent_type: "Explore",
  prompt: "Analyze the codebase. Map file structure, key modules, patterns, and conventions. Summarize findings concisely for a planning session.",
  description: "This agent will quickly explore the codebase to gather relevant context for planning. It should focus on high-level structure, key modules, and any patterns that might influence the plan. The output will be a concise summary that can be fed into the planner agent in Phase 2.",
  model: "gpt-5.4",
  thinking: "medium"
})
```

Read the explore's summary from the subagent result before proceeding.

---

## Phase 2: Plan

## Your Task

Use [findings from Phase 1 here] as context.

### **Restate Requirements**

**Goals:**: Clarify what needs to be built

1. use `questionnaire` tool to clarify ambiguities in the user request up front
2. Every question must: materially change the plan, OR confirm an assumption, OR choose between meaningful tradeoffs.
3. Offer only meaningful choices; don't include filler options that are obviously wrong.
4. Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one.

### **Identify Risks**

**Goals:** Surface potential issues, blockers, and dependencies

### **Create Step Plan**

**Goals:** Break down implementation into phases

### **Wait for Confirmation**

**Goals:** MUST receive user approval before proceeding

Use `questionnaire` tool to ask for confirmation [yes/no/modify] on the plan before any code is written

## Output Format

### Requirements Restatement
[Clear, concise restatement of what will be built]

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
[List external dependencies, APIs, services needed]

### Risks
- HIGH: [Critical risks that could block implementation]
- MEDIUM: [Moderate risks to address]
- LOW: [Minor concerns]

### Estimated Complexity
[HIGH/MEDIUM/LOW with time estimates]

**WAITING FOR CONFIRMATION**: Proceed with this plan? (yes/no/modify)

**CRITICAL**: Do NOT write any code until the user explicitly confirms with "yes", "proceed", or similar affirmative response.

---
