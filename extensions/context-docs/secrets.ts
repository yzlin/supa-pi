export interface SecretDetection {
  hasSecret: boolean;
  reason?: string;
  match?: string;
}

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    name: "github token",
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  },
  {
    name: "openai api key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    name: "aws access key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: "assigned secret",
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|credential)\b\s*[:=]\s*["']?[^\s"']{12,}/i,
  },
];

export function detectSecret(text: string): SecretDetection {
  for (const { name, pattern } of SECRET_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        hasSecret: true,
        reason: name,
        match: match[0],
      };
    }
  }

  return { hasSecret: false };
}
