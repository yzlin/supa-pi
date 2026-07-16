/*
 * Argument normalization for the local unified-edit dialect.
 * Raw string and alias handling follows mitsuhiko/agent-stuff
 * extensions/unified-edit.ts at 4bce45560fa55ace2f5dc8634a63a2af464ddc8b
 * (Apache-2.0), modified to reject ambiguous argument objects.
 */
import type { UnifiedEditParameters } from "./unified-edit-schema";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Normalize upstream-compatible arguments before strict schema validation. */
export function prepareUnifiedEditArguments(
  args: unknown
): UnifiedEditParameters {
  if (typeof args === "string") {
    return { text: args };
  }
  const input = record(args);
  if (!input) {
    throw new Error(
      "Edit arguments must be a raw string or one supported text alias."
    );
  }

  const aliases = ["text", "patch", "input", "content"].filter((key) =>
    Object.hasOwn(input, key)
  );
  if (aliases.length !== 1 || Object.keys(input).length !== 1) {
    throw new Error(
      "Edit arguments must be a raw string or exactly one of text, patch, input, or content."
    );
  }
  const value = input[aliases[0]];
  if (typeof value !== "string") {
    throw new Error(`The ${aliases[0]} payload must be a string.`);
  }
  return { text: value };
}
