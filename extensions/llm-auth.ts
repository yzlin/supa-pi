type ModelLike = {
  provider: string;
};

type ModelAuthSuccess = {
  ok: true;
  apiKey?: string;
  headers?: Record<string, string>;
};

type ModelAuthFailure = {
  ok: false;
  error: string;
};

type ModelAuthRegistry =
  | {
      getApiKeyAndHeaders(
        model: unknown
      ): Promise<ModelAuthSuccess | ModelAuthFailure>;
      getApiKey?(model: unknown): Promise<string | undefined>;
      getApiKeyForProvider?(provider: string): Promise<string | undefined>;
    }
  | {
      getApiKey(model: unknown): Promise<string | undefined>;
      getApiKeyAndHeaders?(
        model: unknown
      ): Promise<ModelAuthSuccess | ModelAuthFailure>;
      getApiKeyForProvider?(provider: string): Promise<string | undefined>;
    };

type ProviderAuthRegistry = {
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
  getApiKey?(model: unknown): Promise<string | undefined>;
};

export async function getModelAuthOrThrow(
  modelRegistry: ModelAuthRegistry,
  model: unknown
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
  if ("getApiKeyAndHeaders" in modelRegistry && modelRegistry.getApiKeyAndHeaders) {
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok) {
      return {
        apiKey: auth.apiKey,
        headers: auth.headers,
      };
    }

    const failure = auth as ModelAuthFailure;
    throw new Error(failure.error);
  }

  return {
    apiKey: await modelRegistry.getApiKey(model),
    headers: undefined,
  };
}

export async function getProviderApiKeyForModel(
  modelRegistry: ProviderAuthRegistry,
  model: ModelLike
): Promise<string | undefined> {
  if (modelRegistry.getApiKeyForProvider) {
    return modelRegistry.getApiKeyForProvider(model.provider);
  }

  return modelRegistry.getApiKey?.(model);
}
