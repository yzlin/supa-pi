---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---
# TypeScript/JavaScript Testing

> This file extends [common/testing.md](../common/testing.md) with TypeScript/JavaScript specific content.

## Build and Diagnostic Fixes

For build, compilation, type, module-resolution, dependency, or build-configuration failures, follow the build and diagnostic safeguards in [`tdd-workflow`](../../skills/tdd-workflow/SKILL.md): reproduce the exact command, separate cascades from the root cause, fix the smallest source-level cause without type suppression, repair generators rather than generated output, and verify diagnostics after the fix.

## E2E Testing

Use **Playwright** as the E2E testing framework for critical user flows.

## Skill Support

For main-session E2E work, load [`e2e-testing`](../../skills/e2e-testing/SKILL.md) for the Playwright workflow, guardrails, artifact/CI handling, and reporting.
