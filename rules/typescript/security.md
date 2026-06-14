---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
---
# TypeScript/JavaScript Security

> This file extends [common/security.md](../common/security.md) with TypeScript/JavaScript specific content.

## Secret Management

```typescript
// NEVER: Hardcoded secrets
const apiKey = "sk-proj-xxxxx"

// ALWAYS: Environment variables
const apiKey = process.env.OPENAI_API_KEY

if (!apiKey) {
  throw new Error('OPENAI_API_KEY not configured')
}
```

## Boundary Validation

- Validate API route, server action, webhook, queue, file upload, and third-party API inputs with schemas before use.
- Treat all external data as `unknown` until parsed and validated.
- Return generic user-facing errors; keep internal details in server-side logs only.

## SSRF and Server-Side Fetches

When server code fetches a user-influenced URL:
- allowlist scheme and host
- reject localhost, private, link-local, and reserved IP ranges
- forbid redirects unless each redirect target is revalidated
- prefer fixed integration endpoints over arbitrary user-provided URLs

## AI / LLM Surfaces

- Treat model output as untrusted input.
- Never pass raw model output into SQL, shell commands, `eval`, `innerHTML`, file paths, or tool calls.
- Validate structured model output with schemas before acting on it.
- Do not put secrets, cross-tenant data, or privileged system prompts in model context.
- Scope tool/agent permissions narrowly; require confirmation for destructive or irreversible actions.

## Dependency Supply Chain

Before adding dependencies:
- confirm the existing stack does not already solve the problem
- review package name for typosquatting risk
- check for install scripts such as `postinstall`
- distinguish runtime dependencies from dev-only dependencies
- commit lockfile changes and use reproducible installs in CI

## Agent Support

- Use **security-reviewer** skill for comprehensive security audits
