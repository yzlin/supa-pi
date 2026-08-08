interface ModelLike {
  provider: string;
}

interface ProviderAuthRegistry {
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
  getApiKey?(model: unknown): Promise<string | undefined>;
}

export function getProviderApiKeyForModel(
  modelRegistry: ProviderAuthRegistry,
  model: ModelLike
): Promise<string | undefined> {
  if (modelRegistry.getApiKeyForProvider) {
    return modelRegistry.getApiKeyForProvider(model.provider);
  }

  return modelRegistry.getApiKey?.(model);
}
