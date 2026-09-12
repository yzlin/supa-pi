import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = process.cwd();
const policyPath = join(repositoryRoot, "rules", "common", "security.md");
const skillPath = join(repositoryRoot, "skills", "security-review", "SKILL.md");

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

describe("security policy ownership contract", () => {
  it("keeps the union of shared threat-model, approval, and prohibited-action safeguards in the common rule", () => {
    const policy = readFile(policyPath);

    for (const control of [
      "## Threat Model First",
      "HTTP requests, forms, file uploads, webhooks, third-party APIs, queues, config files, and LLM output",
      "credentials, sessions, PII, payment data, tenant data, admin actions, money movement, and secrets",
      "spoof identity, tamper with data, deny an action, leak information, overload the system, or elevate privileges",
      "If trust boundaries are unclear, stop and clarify before coding.",
      "## Ask First",
      "adding or changing authentication flows",
      "changing authorization, roles, or permissions",
      "storing new categories of sensitive data",
      "adding external service integrations, callbacks, or webhooks",
      "changing CORS, cookie, or security header behavior",
      "adding file upload handlers",
      "modifying rate limits or throttling",
      "granting elevated permissions or destructive capabilities",
      "## Never Do",
      "Never commit secrets or put them in logs.",
      "Never trust client-side validation as a security boundary.",
      "Never expose stack traces or internal errors to users.",
      "Never store auth tokens in client-readable storage when httpOnly cookies are viable.",
      "Never use `eval`, shell execution, SQL execution, or raw HTML rendering with untrusted data",
      "Never pass unvalidated LLM output into privileged code paths.",
      "NEVER edit `.env`, `.env.local`, `.env.*` files",
      "## Security Response Protocol",
      "Inspect the diff for secrets and other sensitive-data exposure on every commit.",
      "only to directly or indirectly affected boundaries",
      "Keep actual safeguards in force at those boundaries.",
      "Stop the affected unsafe work.",
      "Report critical findings immediately.",
      "Independent, demonstrably safe work may continue.",
      "If independence is unclear, pause the affected work and ask for clarification.",
      "Do not automatically repair the whole repository or rotate secrets.",
      "External operational secret rotation requires explicit authorization.",
      "An explicit, scoped user request that names the LOCAL implementation authorizes that security-sensitive local implementation and its necessary tests without repeat consent.",
      "Material scope expansion and separately gated external, destructive, production, or credential actions require separate explicit approval.",
      "Plain or vague goals are not authorization.",
    ]) {
      expect(policy).toContain(control);
    }
  });

  it("makes the common rule the explicit applicable policy owner from the skill directory", () => {
    const skill = readFile(skillPath);
    const policyLink = "../../rules/common/security.md";

    expect(skill).toContain("MUST read and follow");
    expect(skill).toContain(`[Security Guidelines](${policyLink})`);
    expect(skill).toContain("whenever this skill activates");

    const resolvedPolicyPath = resolve(dirname(skillPath), policyLink);
    expect(resolvedPolicyPath).toBe(policyPath);
    expect(existsSync(resolvedPolicyPath)).toBe(true);
    expect(readFile(resolvedPolicyPath)).toContain("# Security Guidelines");
  });

  it("does not duplicate the common policy sections in the task-specific skill", () => {
    const skill = readFile(skillPath);

    expect(skill).not.toContain("## Threat Model First");
    expect(skill).not.toContain("## Ask First");
    expect(skill).not.toContain("## Never Do");
  });
});
