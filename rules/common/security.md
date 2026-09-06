# Security Guidelines

## Threat Model First

Before security-sensitive work, identify:
- trust boundaries: where untrusted data enters or crosses systems, including HTTP requests, forms, file uploads, webhooks, third-party APIs, queues, config files, and LLM output
- assets: credentials, sessions, PII, payment data, tenant data, admin actions, money movement, and secrets
- abuse cases: how someone could spoof identity, tamper with data, deny an action, leak information, overload the system, or elevate privileges, as well as misuse or bypass the feature

If trust boundaries are unclear, stop and clarify before coding.

## Mandatory Security Checks

Before ANY commit:
- [ ] No hardcoded secrets (API keys, passwords, tokens)
- [ ] All user inputs validated at system boundaries
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (sanitized HTML / encoded output)
- [ ] CSRF protection enabled where cookies authorize state changes
- [ ] Authentication/authorization verified
- [ ] Rate limiting on auth, write, and expensive endpoints
- [ ] Error messages don't leak sensitive data or stack traces

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
- Rotate any secrets that may have been exposed
- NEVER edit `.env`, `.env.local`, `.env.*` files — inform the user and let them make the change

## Security Response Protocol

If security issue found:
1. STOP immediately
2. Use **security-reviewer** agent
3. Fix CRITICAL issues before continuing
4. Rotate any exposed secrets
5. Review entire codebase for similar issues
