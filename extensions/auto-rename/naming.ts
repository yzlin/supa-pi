import { createHash } from "node:crypto";

import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

const ABSOLUTE_MAX_NAME_LENGTH = 80;
const MAX_TITLE_TOKENS = 32;
const TRAILING_PUNCTUATION_PATTERN = /[.!?,;:]+$/u;
const UNSAFE_MARKUP_PATTERN = /[`#*_~|\\<>()[\]{}]/u;
const URL_PATTERN =
  /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|dev|app|co)\b)/iu;
const URI_SCHEME_PATTERN = /\b[a-z][a-z0-9+.-]*:(?:\/\/|[^\s]+)/iu;
const REASONING_LABEL_PATTERN =
  /^(?:analysis|reasoning|thoughts?|chain[ -]of[ -]thought|answer)\s*:/iu;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:bearer|api[ _-]?key|password|secret|access[ _-]?token)\s*[:=]\s*\S+/iu;
const CREDENTIAL_PREFIX_PATTERN =
  /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|AKIA|ASIA)[a-z0-9_-]{12,}\b/iu;
const LONG_HEX_PATTERN = /\b[0-9a-f]{24,}\b/iu;
const TOKEN_FRAGMENT_PATTERN = /[a-z0-9_/-]{20,}/giu;
const LATIN_LETTER_PATTERN = /[a-z]/iu;
const DIGIT_PATTERN = /\d/u;
const TOKEN_SEPARATOR_PATTERN = /[_/-]/u;
const ALLOWED_TITLE_PATTERN = /^[\p{L}\p{N} '&+:/\-–—’]+$/u;
const ENDING_ALPHANUMERIC_PATTERN = /[\p{L}\p{N}]$/u;
const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const WRAPPING_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
];

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

export interface TitleGenerationConfig {
  prompt: string;
  maxQueryLength: number;
  maxNameLength: number;
  timeoutMs: number;
}

export interface NamingContext {
  model: Model<Api> | null | undefined;
  modelRegistry: Pick<ModelRegistry, "complete">;
}

export type NamingFailureCategory =
  | "no-model"
  | "timeout"
  | "abort"
  | "provider-error"
  | "aborted-stop"
  | "empty-output"
  | "invalid-output";

export type TitleGenerationResult =
  | { title: string; failure?: never }
  | { title: string; failure: NamingFailureCategory };

/** Create a private, stable name without incorporating any prompt contents. */
export function fallbackSessionName(sessionId: string): string {
  const suffix = createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 8);
  return `session-${suffix}`;
}

/** Normalize harmless presentation noise, then reject any title outside the safety boundary. */
export function normalizeAndValidateTitle(
  output: string,
  configuredMaxLength: number
): string | null {
  if (!output || hasControlCharacter(output)) {
    return null;
  }

  let title = output.trim().replace(/[\t \f\v]+/gu, " ");
  const wrappingQuotes = WRAPPING_QUOTE_PAIRS.find(
    ([start, end]) => title.startsWith(start) && title.endsWith(end)
  );
  if (wrappingQuotes && title.length >= 2) {
    title = title.slice(1, -1).trim();
  }
  title = title.replace(TRAILING_PUNCTUATION_PATTERN, "").trim();

  const maxLength = Math.min(configuredMaxLength, ABSOLUTE_MAX_NAME_LENGTH);
  if (!title || maxLength < 1 || title.length > maxLength) {
    return null;
  }

  if (
    UNSAFE_MARKUP_PATTERN.test(title) ||
    URL_PATTERN.test(title) ||
    URI_SCHEME_PATTERN.test(title) ||
    REASONING_LABEL_PATTERN.test(title) ||
    CREDENTIAL_ASSIGNMENT_PATTERN.test(title) ||
    CREDENTIAL_PREFIX_PATTERN.test(title) ||
    LONG_HEX_PATTERN.test(title)
  ) {
    return null;
  }

  const fragments = title.match(TOKEN_FRAGMENT_PATTERN) ?? [];
  if (
    fragments.some(
      (fragment) =>
        LATIN_LETTER_PATTERN.test(fragment) &&
        DIGIT_PATTERN.test(fragment) &&
        (fragment.length >= 24 || TOKEN_SEPARATOR_PATTERN.test(fragment))
    )
  ) {
    return null;
  }

  if (
    !(
      ALLOWED_TITLE_PATTERN.test(title) &&
      ENDING_ALPHANUMERIC_PATTERN.test(title)
    )
  ) {
    return null;
  }

  const words = title.match(WORD_PATTERN) ?? [];
  if (words.length < 3 || words.length > 6) {
    return null;
  }

  return title;
}

function failed(
  sessionId: string,
  failure: NamingFailureCategory
): TitleGenerationResult {
  return { title: fallbackSessionName(sessionId), failure };
}

/** Make one bounded request to the active model and return a safe title or stable fallback. */
export async function generateSessionTitle(
  ctx: NamingContext,
  source: string,
  sessionId: string,
  config: TitleGenerationConfig,
  callerSignal?: AbortSignal
): Promise<TitleGenerationResult> {
  if (!ctx.model) {
    return failed(sessionId, "no-model");
  }
  if (callerSignal?.aborted) {
    return failed(sessionId, "abort");
  }
  const operationController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    operationController.abort();
  }, config.timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([operationController.signal, callerSignal])
    : operationController.signal;

  const abortResult = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error("naming-aborted")),
      {
        once: true,
      }
    );
  });

  try {
    const request: Context = {
      systemPrompt: config.prompt,
      messages: [
        {
          role: "user",
          content: source.slice(0, config.maxQueryLength),
          timestamp: Date.now(),
        },
      ],
    };
    const completion = ctx.modelRegistry.complete(ctx.model, request, {
      maxTokens: MAX_TITLE_TOKENS,
      timeoutMs: config.timeoutMs,
      maxRetries: 0,
      signal,
    });
    const response = await Promise.race([completion, abortResult]);

    if (response.stopReason === "aborted") {
      return failed(
        sessionId,
        callerSignal?.aborted ? "abort" : "aborted-stop"
      );
    }
    if (response.stopReason === "error") {
      return failed(sessionId, "provider-error");
    }

    const text = response.content
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text"
      )
      .map((part) => part.text)
      .join("\n");
    if (!text.trim()) {
      return failed(sessionId, "empty-output");
    }

    const title = normalizeAndValidateTitle(text, config.maxNameLength);
    return title ? { title } : failed(sessionId, "invalid-output");
  } catch {
    if (timedOut) {
      return failed(sessionId, "timeout");
    }
    if (callerSignal?.aborted || signal.aborted) {
      return failed(sessionId, "abort");
    }
    return failed(sessionId, "provider-error");
  } finally {
    clearTimeout(timeout);
    operationController.abort();
  }
}
