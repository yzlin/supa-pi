import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = process.cwd();
const skillPath = join(repositoryRoot, "skills", "security-review", "SKILL.md");

const originalSolanaBlock = `### 9. Blockchain Security (Solana)

#### Wallet Verification
\`\`\`typescript
import { verify } from '@solana/web3.js'

async function verifyWalletOwnership(
  publicKey: string,
  signature: string,
  message: string
) {
  try {
    const isValid = verify(
      Buffer.from(message),
      Buffer.from(signature, 'base64'),
      Buffer.from(publicKey, 'base64')
    )
    return isValid
  } catch (error) {
    return false
  }
}
\`\`\`

#### Transaction Verification
\`\`\`typescript
async function verifyTransaction(transaction: Transaction) {
  // Verify recipient
  if (transaction.to !== expectedRecipient) {
    throw new Error('Invalid recipient')
  }

  // Verify amount
  if (transaction.amount > maxAmount) {
    throw new Error('Amount exceeds limit')
  }

  // Verify user has sufficient balance
  const balance = await getBalance(transaction.from)
  if (balance < transaction.amount) {
    throw new Error('Insufficient balance')
  }

  return true
}
\`\`\`

#### Verification Steps
- [ ] Wallet signatures verified
- [ ] Transaction details validated
- [ ] Balance checks before transactions
- [ ] No blind transaction signing
`;

const originalSsrfBlock = `### 10. SSRF Prevention

Any server-side fetch influenced by users can target internal services such as localhost, private networks, or cloud metadata endpoints.

#### ❌ NEVER Fetch Arbitrary User URLs
\`\`\`typescript
// DANGEROUS - user can target internal services
await fetch(req.body.webhookUrl)
\`\`\`

#### ✅ Prefer Allowlisted Endpoints
\`\`\`typescript
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
\`\`\`

#### Verification Steps
- [ ] User-influenced server fetches use scheme and host allowlists
- [ ] Localhost, private, link-local, and reserved IP ranges rejected on high-risk paths
- [ ] Redirects disabled or each redirect target revalidated
- [ ] Fixed integration endpoints preferred over arbitrary URLs
`;

const originalAiBlock = `### 11. AI / LLM Security

Treat model output like any other untrusted input. Prompts are not a security boundary.

#### ❌ NEVER Trust Model Output Directly
\`\`\`typescript
const sql = await model.generate(\`Write SQL for: \${userQuestion}\`)
await db.query(sql) // arbitrary query execution

const html = await model.generate(userPrompt)
element.innerHTML = html // XSS risk
\`\`\`

#### ✅ Validate and Constrain Model Output
\`\`\`typescript
const raw = await model.generateObject({ prompt: userPrompt, schema: ActionSchema })
const action = ActionSchema.parse(raw)

await runAllowlistedAction(action.name, action.args)
\`\`\`

#### Verification Steps
- [ ] Model output validated before use
- [ ] No raw model output passed to SQL, shell, \`eval\`, HTML, file paths, or tool calls
- [ ] Secrets, cross-tenant data, and privileged system prompts kept out of model context
- [ ] Tool permissions scoped to the minimum required
- [ ] Destructive or irreversible tool actions require confirmation
- [ ] Token, loop, and request limits prevent unbounded consumption
`;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("security selective reference contract", () => {
  it("routes each specialized risk to one resolvable skill-relative reference", () => {
    const skill = read(skillPath);
    const routes = [
      {
        text: "For Solana wallet verification or transaction signing work, you MUST read [Solana security](references/solana.md).",
        link: "references/solana.md",
      },
      {
        text: "For a user-influenced server-side fetch, you MUST read [SSRF prevention](references/ssrf.md).",
        link: "references/ssrf.md",
      },
      {
        text: "For work where LLM output or tools can affect application behavior, you MUST read [AI / LLM security](references/ai.md).",
        link: "references/ai.md",
      },
    ] as const;

    for (const route of routes) {
      expect(skill).toContain(route.text);
      expect(
        skill.match(new RegExp(route.link.replace(".", "\\."), "g"))
      ).toHaveLength(1);

      const referencePath = resolve(dirname(skillPath), route.link);
      expect(referencePath.startsWith(dirname(skillPath))).toBe(true);
      expect(existsSync(referencePath)).toBe(true);
    }
  });

  it("keeps nearby ordinary input validation from loading all specialized references", () => {
    const skill = read(skillPath);

    expect(skill).toContain(
      "Ordinary input-validation work does not automatically load any of these specialized references."
    );
    expect(skill).not.toContain("read all specialized references");
    expect(skill).not.toContain("read all three references");
  });

  it("preserves each moved section byte-for-byte in its matching reference", () => {
    const references = [
      ["solana.md", originalSolanaBlock],
      ["ssrf.md", originalSsrfBlock],
      ["ai.md", originalAiBlock],
    ] as const;

    for (const [file, originalBlock] of references) {
      const content = read(
        join(repositoryRoot, "skills", "security-review", "references", file)
      );
      expect(digest(content)).toBe(digest(originalBlock));
    }
  });

  it("does not duplicate the moved long recipes in the entrypoint", () => {
    const skill = read(skillPath);

    for (const movedContent of [
      "import { verify } from '@solana/web3.js'",
      "async function verifyTransaction(transaction: Transaction)",
      "await fetch(req.body.webhookUrl)",
      "const ALLOWED_WEBHOOK_HOSTS = new Set(['hooks.example.com'])",
      "const sql = await model.generate",
      "await runAllowlistedAction(action.name, action.args)",
    ]) {
      expect(skill).not.toContain(movedContent);
    }
  });

  it("keeps mandatory common-policy loading, safety decisions, and remaining guidance intact", () => {
    const skill = read(skillPath);

    expect(skill).toContain(
      "Before beginning work, you MUST read and follow the canonical [Security Guidelines](../../rules/common/security.md). That common rule owns the shared threat-model, approval, and prohibited-action baseline and applies whenever this skill activates; load it directly from this link rather than assuming a rules extension or global catalog search supplied it."
    );

    for (const retained of [
      "origin: ECC",
      "### 1. Secrets Management",
      "const CreateUserSchema = z.object({",
      "### 4. Authentication & Authorization",
      "ALTER TABLE users ENABLE ROW LEVEL SECURITY;",
      "### 8. Sensitive Data Exposure",
      "### 12. Dependency Security",
      "## Security Testing",
      "test('requires authentication'",
      "## Pre-Deployment Security Checklist",
      "[ ] **SSRF**: User-influenced server fetches allowlisted and redirect-safe",
      "[ ] **AI/LLM**: Model output validated before privileged use",
      "[ ] **Wallet Signatures**: Verified (if blockchain)",
      "- [OWASP Top 10](https://owasp.org/www-project-top-ten/)",
      "- [Next.js Security](https://nextjs.org/docs/security)",
      "- [Supabase Security](https://supabase.com/docs/guides/auth)",
      "- [Web Security Academy](https://portswigger.net/web-security)",
      "**Remember**: Security is not optional. One vulnerability can compromise the entire platform. When in doubt, err on the side of caution.",
    ]) {
      expect(skill).toContain(retained);
    }
  });
});
