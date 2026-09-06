### 10. SSRF Prevention

Any server-side fetch influenced by users can target internal services such as localhost, private networks, or cloud metadata endpoints.

#### ❌ NEVER Fetch Arbitrary User URLs
```typescript
// DANGEROUS - user can target internal services
await fetch(req.body.webhookUrl)
```

#### ✅ Prefer Allowlisted Endpoints
```typescript
const ALLOWED_WEBHOOK_HOSTS = new Set(['hooks.example.com'])

function assertAllowedWebhookUrl(raw: string) {
  const url = new URL(raw)

  if (url.protocol !== 'https:') {
    throw new Error('HTTPS required')
  }

  if (!ALLOWED_WEBHOOK_HOSTS.has(url.hostname)) {
    throw new Error('Webhook host not allowed')
  }

  return url
}

await fetch(assertAllowedWebhookUrl(input.webhookUrl), { redirect: 'error' })
```

#### Verification Steps
- [ ] User-influenced server fetches use scheme and host allowlists
- [ ] Localhost, private, link-local, and reserved IP ranges rejected on high-risk paths
- [ ] Redirects disabled or each redirect target revalidated
- [ ] Fixed integration endpoints preferred over arbitrary URLs
