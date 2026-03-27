import { describe, expect, it } from "bun:test";

import { getModelAuthOrThrow, getProviderApiKeyForModel } from "./llm-auth";

describe("getModelAuthOrThrow", () => {
  it("returns api key and headers from the registry", async () => {
    const auth = await getModelAuthOrThrow(
      {
        async getApiKeyAndHeaders() {
          return {
            ok: true as const,
            apiKey: "token",
            headers: {
              "x-test": "1",
            },
          };
        },
      },
      { provider: "openai", id: "gpt-5" }
    );

    expect(auth).toEqual({
      apiKey: "token",
      headers: {
        "x-test": "1",
      },
    });
  });

  it("throws the registry error when auth resolution fails", async () => {
    await expect(
      getModelAuthOrThrow(
        {
          async getApiKeyAndHeaders() {
            return {
              ok: false as const,
              error: "Missing auth",
            };
          },
        },
        { provider: "openai", id: "gpt-5" }
      )
    ).rejects.toThrow("Missing auth");
  });

  it("falls back to legacy model-level api key lookup", async () => {
    const auth = await getModelAuthOrThrow(
      {
        async getApiKey() {
          return "legacy-token";
        },
      },
      { provider: "openai", id: "gpt-5" }
    );

    expect(auth).toEqual({
      apiKey: "legacy-token",
      headers: undefined,
    });
  });
});

describe("getProviderApiKeyForModel", () => {
  it("looks up the key by provider", async () => {
    const apiKey = await getProviderApiKeyForModel(
      {
        async getApiKeyForProvider(provider: string) {
          return provider === "anthropic" ? "oauth-token" : undefined;
        },
      },
      { provider: "anthropic" }
    );

    expect(apiKey).toBe("oauth-token");
  });

  it("falls back to legacy model-level lookup", async () => {
    const model = { provider: "anthropic", id: "claude-haiku-4-5" };
    const apiKey = await getProviderApiKeyForModel(
      {
        async getApiKey(input: unknown) {
          return input === model ? "legacy-oauth-token" : undefined;
        },
      },
      model
    );

    expect(apiKey).toBe("legacy-oauth-token");
  });
});
