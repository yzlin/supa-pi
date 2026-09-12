# Security Guidelines

## Threat Model First

Before security-sensitive work, identify:
- trust boundaries: where untrusted data enters or crosses systems, including HTTP requests, forms, file uploads, webhooks, third-party APIs, queues, config files, and LLM output
- assets: credentials, sessions, PII, payment data, tenant data, admin actions, money movement, and secrets
- abuse cases: how someone could spoof identity, tamper with data, deny an action, leak information, overload the system, or elevate privileges, as well as misuse or bypass the feature

If trust boundaries are unclear, stop and clarify before coding.

## Mandatory Security Checks

Before ANY commit:
- [ ] Inspect the diff for secrets and other sensitive-data exposure on every commit.
- [ ] Apply the following control checks only to directly or indirectly affected boundaries.
- [ ] Keep actual safeguards in force at those boundaries.
  - [ ] All user inputs validated at system boundaries
  - [ ] SQL injection prevention (parameterized queries)
  - [ ] XSS prevention (sanitized HTML / encoded output)
  - [ ] CSRF protection enabled where cookies authorize state changes
  - [ ] Authentication/authorization verified
  - [ ] Rate limiting on auth, write, and expensive endpoints
  - [ ] Error messages don't leak sensitive data or stack traces
- [ ] Verify other applicable security controls at each directly or indirectly affected boundary.

## Ask First

Get explicit user approval before:
- adding or changing authentication flows
- changing authorization, roles, or permissions
- storing new categories of sensitive data
- adding external service integrations, callbacks, or webhooks
- changing CORS, cookie, or security header behavior
- adding file upload handlers
- modifying rate limits or throttling
- granting elevated permissions or destructive capabilities

An explicit, scoped user request that names the LOCAL implementation authorizes that security-sensitive local implementation and its necessary tests without repeat consent. Material scope expansion and separately gated external, destructive, production, or credential actions require separate explicit approval. Plain or vague goals are not authorization.

## Never Do

- Never hardcode secrets in source code
- Never commit secrets or put them in logs.
- Never log passwords, tokens, API keys, private keys, full payment data, or session identifiers
- Never trust client-side validation as a security boundary.
- Never expose stack traces or internal errors to users.
- Never store auth tokens in client-readable storage when httpOnly cookies are viable.
- Never use `eval`, shell execution, SQL execution, or raw HTML rendering with untrusted data
- Never pass unvalidated LLM output into privileged code paths.

## Secret Management

- NEVER hardcode secrets in source code
- ALWAYS use environment variables or a secret manager
- Validate that required secrets are present at startup
- External operational secret rotation requires explicit authorization.
- If secrets may have been exposed, report the exposure; do not rotate them automatically as part of local work.
- NEVER edit `.env`, `.env.local`, `.env.*` files — inform the user and let them make the change

## Security Response Protocol

If a security issue is found:
1. Stop the affected unsafe work.
2. Report critical findings immediately.
3. Use **security-reviewer** agent when the active workflow requires specialist review.
4. Fix critical issues before resuming affected work, unless an authorized reviewer documents a different disposition.
5. Independent, demonstrably safe work may continue.
6. If independence is unclear, pause the affected work and ask for clarification.
7. Do not proceed with the affected work until clarified.
8. Do not automatically repair the whole repository or rotate secrets.
9. Keep local repair within the approved scope; broader repair and external operational actions require explicit authorization.
