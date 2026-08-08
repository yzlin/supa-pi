import { describe, expect, it } from "bun:test";

import { getProviderApiKeyForModel } from "./llm-auth";

describe("getProviderApiKeyForModel", () => {
  it("looks up the key by provider", async () => {
    const apiKey = await getProviderApiKeyForModel(
      {
        getApiKeyForProvider(provider: string) {
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
        getApiKey(input: unknown) {
          return input === model ? "legacy-oauth-token" : undefined;
        },
      },
      model
    );

    expect(apiKey).toBe("legacy-oauth-token");
  });
});
