import type { OmConfigInput, OmConfigSnapshot } from "./types";

const DEFAULT_OBSERVATION_CONFIG = Object.freeze({
  messageTokens: 12000,
  previousObserverTokens: 2000,
  bufferTokens: 0.2,
  bufferActivation: 0.8,
  blockAfter: 1.2,
});

const DEFAULT_REFLECTION_CONFIG = Object.freeze({
  observationTokens: 8000,
  bufferActivation: 0.5,
  blockAfter: 1.2,
});

export const DEFAULT_OM_CONFIG_SNAPSHOT: OmConfigSnapshot = Object.freeze({
  enabled: true,
  model: null,
  headerMaxFacts: 6,
  headerMaxThreads: 4,
  observerMaxTurns: 8,
  compactionMaxObservations: 6,
  compactionMaxReflections: 6,
  reflectionMinObservationCount: 12,
  observation: {
    ...DEFAULT_OBSERVATION_CONFIG,
  },
  reflection: {
    ...DEFAULT_REFLECTION_CONFIG,
  },
  observationMessageTokens: DEFAULT_OBSERVATION_CONFIG.messageTokens,
  observationPreviousTokens: DEFAULT_OBSERVATION_CONFIG.previousObserverTokens,
  reflectionObservationTokens: DEFAULT_REFLECTION_CONFIG.observationTokens,
  headerMaxTokens: 800,
  compactionMaxTokens: 1200,
  shareTokenBudget: false,
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeModelSpecifier(
  value: unknown,
  fallback: string | null
): string | null {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  if (!normalized) {
    return fallback;
  }

  const slashIndex = normalized.indexOf("/");
  if (slashIndex === -1) {
    return normalized;
  }

  if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
    return fallback;
  }

  return normalized;
}

function normalizeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
}

function normalizeIntegerOrFalse(
  value: unknown,
  fallback: number | false
): number | false {
  if (value === false) {
    return false;
  }

  if (fallback === false) {
    return normalizeInteger(value, 1);
  }

  return normalizeInteger(value, fallback);
}

function normalizeRatio(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, value);
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function normalizePositiveNumberOrFalse(
  value: unknown,
  fallback: number | false
): number | false {
  if (value === false) {
    return false;
  }

  return normalizePositiveNumber(value, fallback === false ? 1 : fallback);
}

function resolveConfigValue(
  canonicalValue: unknown,
  legacyValue: unknown
): unknown {
  return canonicalValue !== undefined ? canonicalValue : legacyValue;
}

export function createOmConfigSnapshot(
  input: OmConfigInput | Record<string, unknown> = {}
): OmConfigSnapshot {
  const config = asRecord(input);
  const observationConfig = asRecord(config.observation);
  const reflectionConfig = asRecord(config.reflection);
  const observationMessageTokens = normalizeInteger(
    resolveConfigValue(
      observationConfig.messageTokens,
      config.observationMessageTokens
    ),
    DEFAULT_OM_CONFIG_SNAPSHOT.observation.messageTokens
  );
  const observationPreviousTokens = normalizeIntegerOrFalse(
    resolveConfigValue(
      observationConfig.previousObserverTokens,
      config.observationPreviousTokens
    ),
    DEFAULT_OM_CONFIG_SNAPSHOT.observation.previousObserverTokens
  );
  const reflectionObservationTokens = normalizeInteger(
    resolveConfigValue(
      reflectionConfig.observationTokens,
      config.reflectionObservationTokens
    ),
    DEFAULT_OM_CONFIG_SNAPSHOT.reflection.observationTokens
  );
  const observationBufferTokens = normalizePositiveNumberOrFalse(
    observationConfig.bufferTokens,
    DEFAULT_OM_CONFIG_SNAPSHOT.observation.bufferTokens
  );
  const observationBufferActivation = normalizePositiveNumber(
    observationConfig.bufferActivation,
    DEFAULT_OM_CONFIG_SNAPSHOT.observation.bufferActivation
  );
  const observationBlockAfter = normalizeRatio(
    observationConfig.blockAfter,
    DEFAULT_OM_CONFIG_SNAPSHOT.observation.blockAfter
  );
  const reflectionBufferActivation = normalizePositiveNumber(
    reflectionConfig.bufferActivation,
    DEFAULT_OM_CONFIG_SNAPSHOT.reflection.bufferActivation
  );
  const reflectionBlockAfter = normalizeRatio(
    reflectionConfig.blockAfter,
    DEFAULT_OM_CONFIG_SNAPSHOT.reflection.blockAfter
  );

  return {
    enabled: normalizeBoolean(
      config.enabled,
      DEFAULT_OM_CONFIG_SNAPSHOT.enabled
    ),
    model: normalizeModelSpecifier(
      config.model,
      DEFAULT_OM_CONFIG_SNAPSHOT.model
    ),
    headerMaxFacts: normalizeInteger(
      config.headerMaxFacts,
      DEFAULT_OM_CONFIG_SNAPSHOT.headerMaxFacts
    ),
    headerMaxThreads: normalizeInteger(
      config.headerMaxThreads,
      DEFAULT_OM_CONFIG_SNAPSHOT.headerMaxThreads
    ),
    observerMaxTurns: normalizeInteger(
      config.observerMaxTurns,
      DEFAULT_OM_CONFIG_SNAPSHOT.observerMaxTurns
    ),
    compactionMaxObservations: normalizeInteger(
      config.compactionMaxObservations,
      DEFAULT_OM_CONFIG_SNAPSHOT.compactionMaxObservations
    ),
    compactionMaxReflections: normalizeInteger(
      config.compactionMaxReflections,
      DEFAULT_OM_CONFIG_SNAPSHOT.compactionMaxReflections
    ),
    reflectionMinObservationCount: normalizeInteger(
      config.reflectionMinObservationCount,
      DEFAULT_OM_CONFIG_SNAPSHOT.reflectionMinObservationCount
    ),
    observation: {
      messageTokens: observationMessageTokens,
      previousObserverTokens: observationPreviousTokens,
      bufferTokens: observationBufferTokens,
      bufferActivation: observationBufferActivation,
      blockAfter: observationBlockAfter,
    },
    reflection: {
      observationTokens: reflectionObservationTokens,
      bufferActivation: reflectionBufferActivation,
      blockAfter: reflectionBlockAfter,
    },
    observationMessageTokens,
    observationPreviousTokens,
    reflectionObservationTokens,
    headerMaxTokens: normalizeIntegerOrFalse(
      config.headerMaxTokens,
      DEFAULT_OM_CONFIG_SNAPSHOT.headerMaxTokens
    ),
    compactionMaxTokens: normalizeIntegerOrFalse(
      config.compactionMaxTokens,
      DEFAULT_OM_CONFIG_SNAPSHOT.compactionMaxTokens
    ),
    shareTokenBudget: normalizeBoolean(
      config.shareTokenBudget,
      DEFAULT_OM_CONFIG_SNAPSHOT.shareTokenBudget
    ),
  };
}

export function mergeOmConfigSnapshot(
  base: OmConfigInput | Record<string, unknown>,
  overrides: OmConfigInput | Record<string, unknown> = {}
): OmConfigSnapshot {
  const baseSnapshot = createOmConfigSnapshot(base);
  const overrideConfig = asRecord(overrides);
  const overrideObservation = asRecord(overrideConfig.observation);
  const overrideReflection = asRecord(overrideConfig.reflection);
  const mergedModel =
    overrideConfig.model === undefined
      ? baseSnapshot.model
      : normalizeModelSpecifier(overrideConfig.model, baseSnapshot.model);

  return createOmConfigSnapshot({
    ...baseSnapshot,
    ...overrideConfig,
    model: mergedModel,
    observation: {
      ...baseSnapshot.observation,
      ...overrideObservation,
      ...(overrideConfig.observationMessageTokens !== undefined
        ? { messageTokens: overrideConfig.observationMessageTokens }
        : {}),
      ...(overrideConfig.observationPreviousTokens !== undefined
        ? { previousObserverTokens: overrideConfig.observationPreviousTokens }
        : {}),
    },
    reflection: {
      ...baseSnapshot.reflection,
      ...overrideReflection,
      ...(overrideConfig.reflectionObservationTokens !== undefined
        ? { observationTokens: overrideConfig.reflectionObservationTokens }
        : {}),
    },
  });
}
