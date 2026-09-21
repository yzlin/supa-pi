import { createHash } from "node:crypto";

export interface CanonicalMessageIdentity {
  identity: string;
  index: number;
  role: string;
}

/**
 * Identifies visible canonical messages without retaining their content.
 * Occurrences keep otherwise-identical messages distinct and deterministic.
 */
export function identifyCanonicalMessages(
  messages: readonly unknown[]
): CanonicalMessageIdentity[] {
  const occurrences = new Map<string, number>();
  const identified: CanonicalMessageIdentity[] = [];
  for (const [index, message] of messages.entries()) {
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const role = Reflect.get(message, "role");
    if (typeof role !== "string") {
      continue;
    }
    const serialized = JSON.stringify([
      role,
      Reflect.get(message, "timestamp") ?? null,
      Reflect.get(message, "content") ?? null,
      Reflect.get(message, "customType") ?? null,
    ]);
    const digest = createHash("sha256").update(serialized).digest("hex");
    const occurrence = occurrences.get(digest) ?? 0;
    occurrences.set(digest, occurrence + 1);
    identified.push({ identity: `${digest}:${occurrence}`, index, role });
  }
  return identified;
}
