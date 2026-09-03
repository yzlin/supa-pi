import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
  fallbackSessionName,
  generateSessionTitle,
  type NamingContext,
  type NamingFailureCategory,
  normalizeAndValidateTitle,
  type TitleGenerationConfig,
} from "./naming";

const CONFIG: TitleGenerationConfig = {
  prompt: "Return only a safe 3-6 word session title.",
  maxQueryLength: 12,
  maxNameLength: 80,
  timeoutMs: 25,
};
const MODEL = {
  id: "active-model",
  provider: "test",
  api: "test-api",
} as never;
const CODEX_MODEL = {
  id: "active-codex-model",
  provider: "openai-codex",
  api: "openai-codex-responses",
} as never;

function response(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop"
) {
  return {
    content: text ? [{ type: "text" as const, text }] : [],
    stopReason,
  } as AssistantMessage;
}

function context(
  model: NamingContext["model"],
  complete: NamingContext["modelRegistry"]["complete"]
): NamingContext {
  return { model, modelRegistry: { complete } };
}

function expectedFailure(
  sessionId: string,
  failure: NamingFailureCategory
): { title: string; failure: NamingFailureCategory } {
  return { title: fallbackSessionName(sessionId), failure };
}

describe("fallbackSessionName", () => {
  it("uses only the first eight SHA-256 hex characters of the session ID", () => {
    const sessionId = "private-session-id";
    expect(fallbackSessionName(sessionId)).toBe(
      `session-${createHash("sha256").update(sessionId).digest("hex").slice(0, 8)}`
    );
    expect(fallbackSessionName(sessionId)).not.toContain("private-session-id");
  });
});

describe("normalizeAndValidateTitle", () => {
  it("normalizes harmless surrounding whitespace, quotes, and ending punctuation", () => {
    expect(
      normalizeAndValidateTitle('  "Build   Safe Model Titles!"  ', 80)
    ).toBe("Build Safe Model Titles");
  });

  it("accepts plain titles with basic separators and the configured length bound", () => {
    expect(
      normalizeAndValidateTitle("Review TypeScript Safety - Fast", 80)
    ).toBe("Review TypeScript Safety - Fast");
    expect(normalizeAndValidateTitle("Plan API: Safe Client Flow", 80)).toBe(
      "Plan API: Safe Client Flow"
    );
    expect(normalizeAndValidateTitle("One Two Three", 13)).toBe(
      "One Two Three"
    );
  });

  it.each([
    ["", "empty"],
    ["Only Two", "too few words"],
    ["One Two Three Four Five Six Seven", "too many words"],
    ["First Safe Line\nReasoning: hidden", "multiline reasoning"],
    ["**Build Safe Model Titles**", "markup"],
    ["``` Safe Model Title ```", "code fence"],
    ["Visit https://example.com Today", "URL"],
    ["Fetch ftp://private-host/secret Files", "FTP URI"],
    ["Open file:///Users/name/private Path", "file URI"],
    ["Inspect custom+private:resource/path Today", "custom URI scheme"],
    ["Safe\u0007 Model Title", "control character"],
    ["Reasoning: Build Safe Titles", "reasoning label"],
    ["Store sk-proj-1234567890abcdef Token", "credential prefix"],
    ["Rotate github_pat_11AA22BB33CC44DD55EE Token", "token prefix"],
    ["Inspect 0123456789abcdef0123456789abcdef Hash", "token-shaped hash"],
    ["Name Has Emoji 🚀 Today", "non-plain text"],
    ["Ends With Slash /", "ending separator"],
  ])("rejects %s (%s)", (title) => {
    expect(normalizeAndValidateTitle(title, 80)).toBeNull();
  });

  it("enforces both configured and absolute length caps", () => {
    expect(normalizeAndValidateTitle("Three Quite Long Words", 12)).toBeNull();
    expect(
      normalizeAndValidateTitle(`${"A".repeat(70)} Second Third`, 500)
    ).toBeNull();
  });
});

describe("generateSessionTitle", () => {
  it("makes one bounded request using only the active model and source", async () => {
    const calls: unknown[][] = [];
    const ctx = context(MODEL, ((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(response("Build Safe Session Titles"));
    }) as NamingContext["modelRegistry"]["complete"]);

    const startedAt = Date.now();
    const result = await generateSessionTitle(
      ctx,
      "abcdefghijklmnop secret remainder",
      "session-a",
      CONFIG
    );
    const finishedAt = Date.now();

    expect(result).toEqual({ title: "Build Safe Session Titles" });
    expect(calls).toHaveLength(1);
    const [model, request, options] = calls[0] as [
      unknown,
      {
        systemPrompt: string;
        messages: Array<{
          role: string;
          content: string;
          timestamp: number;
        }>;
      },
      {
        maxTokens: number;
        timeoutMs: number;
        maxRetries: number;
        signal: AbortSignal;
      },
    ];
    expect(model).toBe(MODEL);
    expect(request.systemPrompt).toBe(CONFIG.prompt);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]).toEqual({
      role: "user",
      content: "abcdefghijkl",
      timestamp: expect.any(Number),
    });
    expect(request.messages[0]?.timestamp).toBeGreaterThanOrEqual(startedAt);
    expect(request.messages[0]?.timestamp).toBeLessThanOrEqual(finishedAt);
    expect(options.maxTokens).toBe(32);
    expect(options.timeoutMs).toBe(CONFIG.timeoutMs);
    expect(options.maxRetries).toBe(0);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("generates a semantic title with the active Codex model", async () => {
    const calls: unknown[][] = [];
    const ctx = context(CODEX_MODEL, ((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(response("Inspect Failed Session Rename"));
    }) as NamingContext["modelRegistry"]["complete"]);

    const result = await generateSessionTitle(
      ctx,
      "sensitive prompt",
      "codex-session",
      CONFIG
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(CODEX_MODEL);
    expect(result).toEqual({ title: "Inspect Failed Session Rename" });
  });

  it("keeps the private fallback when Codex generation fails", async () => {
    const ctx = context(CODEX_MODEL, (async () =>
      response("", "error")) as NamingContext["modelRegistry"]["complete"]);

    const result = await generateSessionTitle(
      ctx,
      "sensitive prompt",
      "codex-session",
      CONFIG
    );

    expect(result).toEqual(expectedFailure("codex-session", "provider-error"));
  });

  it("returns categorized stable fallbacks for unavailable and unsafe results", async () => {
    const cases: Array<{
      expected: NamingFailureCategory;
      ctx: NamingContext;
    }> = [
      {
        expected: "no-model",
        ctx: context(null, (async () => response("Never Called")) as never),
      },
      {
        expected: "aborted-stop",
        ctx: context(MODEL, (async () =>
          response("Safe Model Naming Title", "aborted")) as never),
      },
      {
        expected: "provider-error",
        ctx: context(MODEL, (async () => response("", "error")) as never),
      },
      {
        expected: "provider-error",
        ctx: context(MODEL, (async () =>
          response("Partial Provider Failure Title", "error")) as never),
      },
      {
        expected: "empty-output",
        ctx: context(MODEL, (async () => response("   ")) as never),
      },
      {
        expected: "invalid-output",
        ctx: context(MODEL, (async () =>
          response("Reasoning:\nUnsafe Model Title")) as never),
      },
      {
        expected: "provider-error",
        ctx: context(MODEL, (() =>
          Promise.reject(new Error("secret provider detail"))) as never),
      },
    ];

    for (const testCase of cases) {
      expect(
        await generateSessionTitle(
          testCase.ctx,
          "sensitive prompt",
          "stable-session",
          CONFIG
        )
      ).toEqual(expectedFailure("stable-session", testCase.expected));
    }
  });

  it("owns the timeout signal and categorizes a timed-out provider", async () => {
    let receivedSignal: AbortSignal | undefined;
    const ctx = context(MODEL, (async (_model, _request, options) => {
      receivedSignal = options?.signal;
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error("provider included private detail")),
          { once: true }
        );
      });
      return response("Never Returned Safe Title");
    }) as NamingContext["modelRegistry"]["complete"]);

    const result = await generateSessionTitle(ctx, "source", "timeout-id", {
      ...CONFIG,
      timeoutMs: 5,
    });

    expect(result).toEqual(expectedFailure("timeout-id", "timeout"));
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("composes caller cancellation into its owned signal", async () => {
    const caller = new AbortController();
    let operationSignal: AbortSignal | undefined;
    const ctx = context(MODEL, (async (_model, _request, options) => {
      operationSignal = options?.signal;
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      return response("Ignored Safe Model Title", "aborted");
    }) as NamingContext["modelRegistry"]["complete"]);

    const promise = generateSessionTitle(
      ctx,
      "source",
      "abort-id",
      CONFIG,
      caller.signal
    );
    caller.abort();

    expect(await promise).toEqual(expectedFailure("abort-id", "abort"));
    expect(operationSignal).not.toBe(caller.signal);
    expect(operationSignal?.aborted).toBe(true);
  });
});
