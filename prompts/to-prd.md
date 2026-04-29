---
description: Turn the current conversation context into a product requirements document
argument-hint: "[extra context]"
---

Create a PRD from the current conversation context, codebase understanding, and any extra context below.

Extra context:
$@

Process:
1. Explore the repo to understand the current state of the codebase, if needed. Use the project's domain glossary vocabulary throughout the PRD, and respect any ADRs in the area being touched.
2. Sketch the major modules that need to be built or modified to complete the implementation. Look for opportunities to extract deep modules that can be tested in isolation.
3. If key product or testing decisions are missing, ask only the smallest number of clarifying questions needed. Otherwise, synthesize from existing context.
4. Write the PRD using the template below.

A deep module, as opposed to a shallow module, encapsulates a lot of functionality behind a simple, testable interface that rarely changes.

<prd-template>

## Problem Statement

The problem the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A long, numbered list of user stories. Each user story should use this format:

1. As an <actor>, I want a <feature>, so that <benefit>

Cover all important aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- Modules that will be built or modified
- Interfaces that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may become outdated quickly.

## Testing Decisions

A list of testing decisions that were made. Include:

- What makes a good test: test external behavior, not implementation details
- Which modules will be tested
- Prior art for the tests, such as similar tests in the codebase

## Out of Scope

Things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>
