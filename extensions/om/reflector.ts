import {
  type AssistantMessage,
  complete,
  type UserMessage,
} from "@mariozechner/pi-ai";

import { getModelAuthOrThrow } from "../llm-auth";
import { createOmStateEnvelope } from "./branch";
import { buildOmReflectorPrompt } from "./prompts";
import { isOmReflectorResult } from "./schema";
import { estimateOmObservationTokens } from "./tokens";
import type {
  OmObservation,
  OmReflection,
  OmReflectorApplyResult,
  OmReflectorPromptInput,
  OmReflectorResult,
  OmReflectorWindow,
  OmStateV1,
} from "./types";

type OmReflectorModel = {
  id: string;
  provider: string;
  input?: readonly string[];
};

interface OmReflectorModelRegistryLike {
  find(provider: string, modelId: string): OmReflectorModel | undefined;
  getAll?(): OmReflectorModel[];
  getAvailable?(): OmReflectorModel[];
  getApiKeyAndHeaders?(model: unknown): Promise<
    | {
        ok: true;
        apiKey?: string;
        headers?: Record<string, string>;
      }
    | {
        ok: false;
        error: string;
      }
  >;
  getApiKey?(model: unknown): Promise<string | undefined>;
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
}

export interface OmReflectorInvokeContext {
  model?: OmReflectorModel | null;
  modelRegistry: OmReflectorModelRegistryLike;
}

export interface OmReflectorInvokeOptions {
  signal?: AbortSignal;
  completeFn?: (
    model: OmReflectorModel,
    context: { messages: UserMessage[] },
    options?: {
      apiKey?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    }
  ) => Promise<AssistantMessage>;
}

const OM_REFLECTOR_MODEL_FALLBACKS = [
  ["anthropic", "claude-haiku-4-5"],
  ["google", "gemini-2.5-flash"],
  ["openai", "gpt-5-mini"],
  ["openai", "gpt-4.1-mini"],
] as const;

function resolveOmReflectorModel(
  context: OmReflectorInvokeContext
): OmReflectorModel | null {
  if (context.model) {
    return context.model;
  }

  for (const [provider, modelId] of OM_REFLECTOR_MODEL_FALLBACKS) {
    const model = context.modelRegistry.find(provider, modelId);
    if (model) {
      return model;
    }
  }

  return null;
}

function extractAssistantTextContent(message: AssistantMessage): string {
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function extractFencedJsonBlock(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);

  if (!fenceMatch) {
    return null;
  }

  const fencedText = fenceMatch[1]?.trim();
  return fencedText ? fencedText : null;
}

export function createEmptyOmReflectorResult(): OmReflectorResult {
  return {
    reflections: [],
  };
}

function sumObservationTokens(observations: readonly OmObservation[]): number {
  return observations.reduce(
    (totalTokens, observation) =>
      totalTokens + estimateOmObservationTokens(observation),
    0
  );
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
}

function normalizeRatio(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, value);
}

function retainNewestObservationsUnderTokenThreshold(
  observations: readonly OmObservation[],
  tokenThreshold: number
): OmObservation[] {
  if (observations.length === 0) {
    return [];
  }

  const retainedObservations: OmObservation[] = [];
  let retainedTokens = 0;

  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index];
    const observationTokens = estimateOmObservationTokens(observation);

    if (
      retainedObservations.length > 0 &&
      retainedTokens + observationTokens >= tokenThreshold
    ) {
      break;
    }

    retainedObservations.unshift(observation);
    retainedTokens += observationTokens;
  }

  return retainedObservations;
}

export function createOmReflectorWindow(state: OmStateV1): OmReflectorWindow {
  const tokenThreshold = normalizePositiveInteger(
    state.configSnapshot.reflection?.observationTokens,
    normalizePositiveInteger(
      state.configSnapshot.reflectionObservationTokens,
      1
    )
  );
  const blockAfter = normalizeRatio(
    state.configSnapshot.reflection?.blockAfter,
    1
  );
  const observationTokens = sumObservationTokens(state.observations);

  if (observationTokens < tokenThreshold) {
    return {
      status: "noop",
      reason: "threshold-not-met",
      observationsToReflect: [],
      retainedObservations: [...state.observations],
    };
  }

  const retainedObservations = retainNewestObservationsUnderTokenThreshold(
    state.observations,
    tokenThreshold
  );
  const splitIndex = Math.max(
    0,
    state.observations.length - retainedObservations.length
  );
  const observationsToReflect = state.observations.slice(0, splitIndex);

  if (observationsToReflect.length === 0) {
    return {
      status: "noop",
      reason: "no-observations-to-reflect",
      observationsToReflect: [],
      retainedObservations: [...state.observations],
    };
  }

  return {
    status: "ready",
    reason:
      observationTokens >= tokenThreshold * blockAfter
        ? "block-after"
        : "ready",
    observationsToReflect,
    retainedObservations,
  };
}

export function createOmReflectorPromptInput(
  state: OmStateV1,
  window: OmReflectorWindow
): OmReflectorPromptInput {
  return {
    observations:
      window.status === "ready"
        ? [...window.observationsToReflect]
        : [...state.observations],
    reflections: [...state.reflections],
    stableFacts: structuredClone(state.stableFacts),
    activeThreads: structuredClone(state.activeThreads),
    configSnapshot: state.configSnapshot,
  };
}

export function buildOmReflectorPromptForWindow(
  state: OmStateV1,
  window: OmReflectorWindow
): string {
  return buildOmReflectorPrompt(createOmReflectorPromptInput(state, window));
}

export async function invokeOmReflector(
  context: OmReflectorInvokeContext,
  state: OmStateV1,
  window: OmReflectorWindow,
  options: OmReflectorInvokeOptions = {}
): Promise<OmReflectorResult> {
  if (window.status !== "ready") {
    return createEmptyOmReflectorResult();
  }

  const model = resolveOmReflectorModel(context);
  if (!model) {
    return createEmptyOmReflectorResult();
  }

  let auth: { apiKey?: string; headers?: Record<string, string> };
  try {
    auth = await getModelAuthOrThrow(context.modelRegistry, model);
  } catch {
    return createEmptyOmReflectorResult();
  }

  const prompt = buildOmReflectorPromptForWindow(state, window);
  const runComplete = options.completeFn ?? complete;

  try {
    const response = await runComplete(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: options.signal,
      }
    );

    if (response.stopReason === "aborted") {
      return createEmptyOmReflectorResult();
    }

    return parseOmReflectorResultText(extractAssistantTextContent(response));
  } catch {
    return createEmptyOmReflectorResult();
  }
}

function parseOmReflectorResultCandidate(
  text: string
): OmReflectorResult | null {
  try {
    const parsedValue = JSON.parse(text) as unknown;
    return isOmReflectorResult(parsedValue) ? parsedValue : null;
  } catch {
    return null;
  }
}

export function parseOmReflectorResultText(text: unknown): OmReflectorResult {
  if (isOmReflectorResult(text)) {
    return structuredClone(text);
  }

  if (typeof text !== "string") {
    return createEmptyOmReflectorResult();
  }

  const trimmedText = text.trim();
  if (!trimmedText) {
    return createEmptyOmReflectorResult();
  }

  const jsonCandidates = new Set<string>([trimmedText]);
  const fencedJson = extractFencedJsonBlock(trimmedText);

  if (fencedJson) {
    jsonCandidates.add(fencedJson);
  }

  for (const jsonCandidate of jsonCandidates) {
    const result = parseOmReflectorResultCandidate(jsonCandidate);

    if (result) {
      return result;
    }
  }

  return createEmptyOmReflectorResult();
}

function normalizeSourceObservationIds(
  observationsToReflect: readonly { id: string }[],
  sourceObservationIds?: readonly string[]
): string[] {
  const allowedObservationIds = new Set(
    observationsToReflect.map((observation) => observation.id)
  );
  const explicitSourceObservationIds =
    sourceObservationIds?.filter((observationId) =>
      allowedObservationIds.has(observationId)
    ) ?? [];

  if (explicitSourceObservationIds.length > 0) {
    return explicitSourceObservationIds;
  }

  return observationsToReflect.map((observation) => observation.id);
}

function createReflectionId(updatedAt: string, index: number): string {
  return `refl-${updatedAt}-${index + 1}`;
}

export function applyOmReflectorResult(
  state: OmStateV1,
  window: OmReflectorWindow,
  reflectorResult: OmReflectorResult,
  updatedAt: string
): OmReflectorApplyResult {
  const clonedState = structuredClone(state);
  const noopEnvelope = createOmStateEnvelope(clonedState, {
    leafId: null,
    entryIds: [],
    lastEntryId: clonedState.lastProcessedEntryId,
  });

  if (window.status !== "ready") {
    return {
      status: "noop",
      reason: window.reason,
      state: clonedState,
      envelope: noopEnvelope,
      shouldPersist: false,
    };
  }

  const nextReflections: OmReflection[] = reflectorResult.reflections.map(
    (reflection, index) => ({
      id: createReflectionId(updatedAt, index),
      summary: reflection.summary,
      sourceObservationIds: normalizeSourceObservationIds(
        window.observationsToReflect,
        reflection.sourceObservationIds
      ),
      createdAt: updatedAt,
    })
  );

  if (nextReflections.length === 0) {
    return {
      status: "noop",
      reason: "no-observations-to-reflect",
      state: clonedState,
      envelope: noopEnvelope,
      shouldPersist: false,
    };
  }

  const nextState: OmStateV1 = {
    ...clonedState,
    observations: [...window.retainedObservations],
    reflections: [...clonedState.reflections, ...nextReflections],
    updatedAt,
  };

  return {
    status: "applied",
    reason: "reflected",
    state: nextState,
    envelope: createOmStateEnvelope(nextState, {
      leafId: null,
      entryIds: [],
      lastEntryId: nextState.lastProcessedEntryId,
    }),
    shouldPersist: true,
  };
}
