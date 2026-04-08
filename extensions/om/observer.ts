import {
  type AssistantMessage,
  complete,
  type UserMessage,
} from "@mariozechner/pi-ai";

import { getModelAuthOrThrow } from "../llm-auth";
import {
  createOmBranchScope,
  createOmStateEnvelope,
  diffOmBranchEntriesSince,
} from "./branch";
import { DEFAULT_OM_CONFIG_SNAPSHOT } from "./config";
import { buildOmObserverPrompt } from "./prompts";
import {
  getOmObserverResultValidationError,
  isOmObserverResult,
} from "./schema";
import {
  estimateOmTurnTokens,
  selectObservationsWithinTokenBudget,
} from "./tokens";
import type {
  OmActiveThread,
  OmObserverApplyResult,
  OmObserverDiagnostic,
  OmObserverPromptInput,
  OmObserverResult,
  OmObserverWindow,
  OmPromptTurn,
  OmStableFact,
  OmStateV1,
} from "./types";
import {
  OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
  OM_REFLECTION_BUFFER_CUSTOM_TYPE,
  OM_STATE_CUSTOM_TYPE,
} from "./version";

interface OmMessageLike {
  role?: string;
  content?: unknown;
  toolName?: string;
  command?: string;
  output?: string;
  customType?: string;
  summary?: string;
  display?: boolean;
  excludeFromContext?: boolean;
}

interface OmObserverEntryLike {
  id: string;
  type?: string;
  customType?: string;
  message?: OmMessageLike;
}

interface OmObserverWindowOptions<TEntry extends { id: string }> {
  leafId?: string | null;
  maxTurns?: number;
  observationMessageTokens?: number;
  blockAfter?: number;
  serializeEntry?: (entry: TEntry) => OmPromptTurn | null;
}

type OmObserverModel = {
  id: string;
  provider: string;
  input?: readonly string[];
};

interface OmObserverModelRegistryLike {
  find(provider: string, modelId: string): OmObserverModel | undefined;
  getAll?(): OmObserverModel[];
  getAvailable?(): OmObserverModel[];
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

export interface OmObserverInvokeContext {
  model?: OmObserverModel | null;
  modelRegistry: OmObserverModelRegistryLike;
}

export interface OmObserverInvokeOptions {
  signal?: AbortSignal;
  completeFn?: (
    model: OmObserverModel,
    context: { messages: UserMessage[]; systemPrompt?: string },
    options?: {
      apiKey?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    }
  ) => Promise<AssistantMessage>;
  onDiagnostic?: (diagnostic: OmObserverDiagnostic) => void;
}

const OM_OBSERVER_SYSTEM_PROMPT =
  "You are the observational memory observer for pi. Follow the user prompt exactly and return strict JSON only.";

const OM_OBSERVER_MODEL_FALLBACKS = [
  ["anthropic", "claude-haiku-4-5"],
  ["google", "gemini-2.5-flash"],
  ["openai", "gpt-5-mini"],
  ["openai", "gpt-4.1-mini"],
] as const;

function resolveOmObserverModel(
  context: OmObserverInvokeContext
): OmObserverModel | null {
  if (context.model) {
    return context.model;
  }

  for (const [provider, modelId] of OM_OBSERVER_MODEL_FALLBACKS) {
    const model = context.modelRegistry.find(provider, modelId);
    if (model) {
      return model;
    }
  }

  return null;
}

function formatOmObserverModelLabel(model: OmObserverModel): string {
  return `${model.provider}/${model.id}`;
}

function buildOmTextPreview(text: string, maxChars = 240): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 3)}...`;
}

function summarizeAssistantResponse(
  message: AssistantMessage,
  model: OmObserverModel
): {
  text: string;
  meta: OmObserverDiagnostic["meta"];
} {
  const content = Array.isArray(message.content) ? message.content : [];
  const textParts = content.filter(
    (part): part is { type: "text"; text: string } => part.type === "text"
  );
  const text = textParts
    .map((part) => part.text)
    .join("\n")
    .trim();
  const contentTypes = [
    ...new Set(
      content.map((part) => normalizeText(asRecord(part).type) || "unknown")
    ),
  ];

  return {
    text,
    meta: {
      model: formatOmObserverModelLabel(model),
      stopReason:
        typeof message.stopReason === "string" ? message.stopReason : null,
      errorMessage:
        typeof message.errorMessage === "string"
          ? normalizeText(message.errorMessage)
          : undefined,
      textPreview: buildOmTextPreview(text),
      contentPartCount: content.length,
      textPartCount: textParts.length,
      textCharCount: text.length,
      contentTypes,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function stringifyUnknown(value: unknown): string {
  const text = normalizeText(value);
  if (text.length > 0) {
    return text;
  }

  if (value === null || value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeAttachmentLabel(value: unknown): string {
  const label = normalizeText(value);
  if (!label) {
    return "";
  }

  const withoutQuery = label.split(/[?#]/, 1)[0] ?? label;
  const segments = withoutQuery.split(/[\\/]/).filter(Boolean);

  return segments.at(-1) ?? withoutQuery;
}

function formatAttachmentPlaceholder(
  kind: "Image" | "File",
  record: Record<string, unknown>
): string {
  const label =
    normalizeAttachmentLabel(record.filename) ||
    normalizeAttachmentLabel(record.fileName) ||
    normalizeAttachmentLabel(record.name) ||
    normalizeAttachmentLabel(record.path) ||
    normalizeAttachmentLabel(record.url) ||
    normalizeText(record.mimeType) ||
    kind.toLowerCase();

  return `[${kind}: ${label}]`;
}

function extractContentPartText(part: unknown): string {
  const record = asRecord(part);

  switch (normalizeText(record.type)) {
    case "text":
      return normalizeText(record.text);
    case "tool-call":
    case "toolCall": {
      const name = normalizeText(record.name);
      return name ? `tool call: ${name}` : "";
    }
    case "image":
      return formatAttachmentPlaceholder("Image", record);
    case "file":
      return formatAttachmentPlaceholder("File", record);
    default:
      return "";
  }
}

function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    const text = normalizeText(content);
    return text ? [text] : [];
  }

  if (!Array.isArray(content)) {
    const partText = extractContentPartText(content);
    const text = partText || normalizeText(asRecord(content).text);
    return text ? [text] : [];
  }

  return content.flatMap((part) => {
    const text = extractContentPartText(part);
    return text ? [text] : [];
  });
}

function extractMessageText(message: OmMessageLike): string {
  const contentText = extractTextParts(message.content).join("\n");

  switch (message.role) {
    case "assistant":
    case "user":
    case "toolResult":
      return contentText;
    case "bashExecution": {
      const command = normalizeText(message.command);
      const output = normalizeText(message.output);
      return [command && `$ ${command}`, output].filter(Boolean).join("\n");
    }
    default:
      return contentText || normalizeText(message.summary);
  }
}

export function serializeOmObserverEntry<TEntry extends OmObserverEntryLike>(
  entry: TEntry
): OmPromptTurn | null {
  if (entry.type !== "message") {
    return null;
  }

  const message = entry.message;
  if (!message || message.excludeFromContext) {
    return null;
  }

  if (
    message.role === "branchSummary" ||
    message.role === "compactionSummary" ||
    (message.role === "custom" && message.display === false)
  ) {
    return null;
  }

  const role = normalizeText(message.role);
  const text = extractMessageText(message);

  if (!role || !text) {
    return null;
  }

  return {
    id: entry.id,
    role,
    text,
  };
}

function isTrackableObserverEntry(entry: {
  type?: string;
  customType?: string;
}): boolean {
  return !(
    entry.type === "custom" &&
    [
      OM_STATE_CUSTOM_TYPE,
      OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
      OM_REFLECTION_BUFFER_CUSTOM_TYPE,
    ].includes(entry.customType ?? "")
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

export function createOmObserverWindow<TEntry extends { id: string }>(
  branchEntries: readonly TEntry[],
  lastProcessedEntryId: string | null | undefined,
  options: OmObserverWindowOptions<TEntry> = {}
): OmObserverWindow<TEntry> {
  const branchScope = createOmBranchScope(branchEntries, options.leafId);
  const delta = diffOmBranchEntriesSince(branchEntries, lastProcessedEntryId);

  if (delta.requiresRebuild) {
    return {
      status: "rebuild",
      reason: "missing-cursor",
      branchScope,
      delta,
      pendingEntryIds: delta.pendingEntries.map((entry) => entry.id),
      newTurns: [],
      cursorAdvanceEntryId: null,
    };
  }

  const pendingEntries = delta.pendingEntries.filter((entry) =>
    isTrackableObserverEntry(entry)
  );
  const pendingEntryIds = pendingEntries.map((entry) => entry.id);

  if (pendingEntries.length === 0) {
    return {
      status: "duplicate",
      reason: "no-new-entries",
      branchScope,
      delta,
      pendingEntryIds,
      newTurns: [],
      cursorAdvanceEntryId: null,
    };
  }

  const serializeEntry = options.serializeEntry ?? serializeOmObserverEntry;
  const maxTurns =
    typeof options.maxTurns === "number" && Number.isFinite(options.maxTurns)
      ? Math.max(1, Math.trunc(options.maxTurns))
      : Number.POSITIVE_INFINITY;
  const observationMessageTokens = normalizePositiveInteger(
    options.observationMessageTokens,
    DEFAULT_OM_CONFIG_SNAPSHOT.observation.messageTokens
  );
  const blockAfter = normalizeRatio(
    options.blockAfter,
    DEFAULT_OM_CONFIG_SNAPSHOT.observation.blockAfter
  );
  const serializedTurns = pendingEntries
    .map((entry) => serializeEntry(entry))
    .filter((turn): turn is OmPromptTurn => Boolean(turn));
  const cursorAdvanceEntryId = pendingEntries.at(-1)?.id ?? null;

  if (serializedTurns.length === 0) {
    return {
      status: "noop",
      reason: "no-completed-turns",
      branchScope,
      delta,
      pendingEntryIds,
      newTurns: [],
      cursorAdvanceEntryId,
    };
  }

  const pendingSerializedTurnTokens = serializedTurns.reduce(
    (totalTokens, turn) => totalTokens + estimateOmTurnTokens(turn),
    0
  );

  if (pendingSerializedTurnTokens < observationMessageTokens) {
    return {
      status: "noop",
      reason: "threshold-not-met",
      branchScope,
      delta,
      pendingEntryIds,
      newTurns: [],
      cursorAdvanceEntryId: null,
    };
  }

  let triggeringSerializedTurnTokens = 0;

  for (let index = serializedTurns.length - 1; index >= 0; index -= 1) {
    triggeringSerializedTurnTokens += estimateOmTurnTokens(
      serializedTurns[index]
    );

    if (triggeringSerializedTurnTokens >= observationMessageTokens) {
      break;
    }
  }

  const newTurns = serializedTurns.slice(-maxTurns);

  return {
    status: "ready",
    reason:
      triggeringSerializedTurnTokens >= observationMessageTokens * blockAfter
        ? "block-after"
        : "new-turns",
    branchScope,
    delta,
    pendingEntryIds,
    newTurns,
    cursorAdvanceEntryId,
  };
}

export function createOmObserverPromptInput(
  state: OmStateV1,
  window: OmObserverWindow
): OmObserverPromptInput {
  const configuredPreviousObservationBudget =
    state.configSnapshot.observation.previousObserverTokens;
  const sharedPreviousObservationBudget = state.configSnapshot.shareTokenBudget
    ? Math.max(
        0,
        state.configSnapshot.observation.messageTokens -
          window.newTurns.reduce(
            (totalTokens, turn) => totalTokens + estimateOmTurnTokens(turn),
            0
          )
      )
    : null;
  const previousObservationBudget =
    sharedPreviousObservationBudget === null
      ? configuredPreviousObservationBudget
      : configuredPreviousObservationBudget === false
        ? sharedPreviousObservationBudget
        : Math.min(
            configuredPreviousObservationBudget,
            sharedPreviousObservationBudget
          );
  const previousObservations =
    previousObservationBudget === false
      ? state.observations
      : selectObservationsWithinTokenBudget(
          state.observations,
          previousObservationBudget
        );

  return {
    branchScope: window.branchScope,
    lastProcessedEntryId: state.lastProcessedEntryId,
    previousObservations: structuredClone(previousObservations),
    newTurns: [...window.newTurns],
    stableFacts: structuredClone(state.stableFacts),
    activeThreads: structuredClone(state.activeThreads),
    ...(state.currentTask ? { currentTask: state.currentTask } : {}),
    ...(state.suggestedNextResponse
      ? { suggestedNextResponse: state.suggestedNextResponse }
      : {}),
    configSnapshot: state.configSnapshot,
  };
}

export function buildOmObserverPromptForWindow(
  state: OmStateV1,
  window: OmObserverWindow
): string {
  return buildOmObserverPrompt(createOmObserverPromptInput(state, window));
}

export function createEmptyOmObserverResult(): OmObserverResult {
  return {
    observations: [],
    stableFacts: [],
    activeThreads: [],
  };
}

function emitOmObserverDiagnostic(
  options: OmObserverInvokeOptions,
  code: OmObserverDiagnostic["code"],
  meta?: OmObserverDiagnostic["meta"]
): void {
  options.onDiagnostic?.({
    code,
    ...(meta ? { meta } : {}),
  });
}

function extractFencedJsonBlock(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);

  if (!fenceMatch) {
    return null;
  }

  const fencedText = fenceMatch[1]?.trim();
  return fencedText ? fencedText : null;
}

function unwrapJsonStringValue(value: unknown, maxDepth = 2): unknown {
  let current = value;

  for (
    let depth = 0;
    depth < maxDepth && typeof current === "string";
    depth += 1
  ) {
    const trimmed = current.trim();

    if (!trimmed) {
      return trimmed;
    }

    try {
      current = JSON.parse(trimmed) as unknown;
    } catch {
      return current;
    }
  }

  return current;
}

function normalizeOmObserverResultCandidate(value: unknown): {
  result: OmObserverResult | null;
  missingTopLevelKeys?: string[];
  parsedTopLevelKeys?: string[];
  validationErrorPath?: string;
  validationErrorMessage?: string;
} {
  const unwrappedValue = unwrapJsonStringValue(value);

  if (isOmObserverResult(unwrappedValue)) {
    return {
      result: structuredClone(unwrappedValue),
      missingTopLevelKeys: [],
      parsedTopLevelKeys: Object.keys(asRecord(unwrappedValue)),
    };
  }

  const record = asRecord(unwrappedValue);
  const parsedTopLevelKeys = Object.keys(record);

  if (parsedTopLevelKeys.length === 0) {
    return {
      result: null,
    };
  }

  const requiredTopLevelKeys = [
    "observations",
    "stableFacts",
    "activeThreads",
  ] as const;
  const missingTopLevelKeys = requiredTopLevelKeys.filter(
    (key) => !(key in record)
  );
  const normalizedValue = {
    observations:
      "observations" in record ? record.observations : ([] as unknown[]),
    stableFacts:
      "stableFacts" in record ? record.stableFacts : ([] as unknown[]),
    activeThreads:
      "activeThreads" in record ? record.activeThreads : ([] as unknown[]),
    ...("currentTask" in record ? { currentTask: record.currentTask } : {}),
    ...("suggestedNextResponse" in record
      ? { suggestedNextResponse: record.suggestedNextResponse }
      : {}),
  } satisfies Record<(typeof requiredTopLevelKeys)[number], unknown> &
    Record<string, unknown>;

  if (!isOmObserverResult(normalizedValue)) {
    const validationError = getOmObserverResultValidationError(normalizedValue);

    return {
      result: null,
      missingTopLevelKeys,
      parsedTopLevelKeys,
      validationErrorPath: validationError?.path,
      validationErrorMessage: validationError?.message,
    };
  }

  return {
    result: normalizedValue,
    missingTopLevelKeys,
    parsedTopLevelKeys,
  };
}

function parseOmObserverResultPayload(text: unknown): {
  result: OmObserverResult;
  diagnosticCode: OmObserverDiagnostic["code"] | null;
  diagnosticMeta?: OmObserverDiagnostic["meta"];
} {
  const normalizedInput = normalizeOmObserverResultCandidate(text);

  if (normalizedInput.result) {
    return {
      result: normalizedInput.result,
      diagnosticCode: null,
    };
  }

  if (typeof text !== "string") {
    return {
      result: createEmptyOmObserverResult(),
      diagnosticCode: "empty-output",
    };
  }

  const trimmedText = text.trim();
  if (!trimmedText) {
    return {
      result: createEmptyOmObserverResult(),
      diagnosticCode: "empty-output",
    };
  }

  const jsonCandidates = [
    extractFencedJsonBlock(trimmedText),
    trimmedText,
  ].filter(
    (candidate, index, candidates): candidate is string =>
      Boolean(candidate) && candidates.indexOf(candidate) === index
  );

  for (const jsonCandidate of jsonCandidates) {
    try {
      const parsedValue = JSON.parse(jsonCandidate) as unknown;
      const normalizedCandidate =
        normalizeOmObserverResultCandidate(parsedValue);

      if (normalizedCandidate.result) {
        return {
          result: normalizedCandidate.result,
          diagnosticCode: null,
        };
      }

      if (normalizedCandidate.parsedTopLevelKeys) {
        return {
          result: createEmptyOmObserverResult(),
          diagnosticCode: "invalid-output",
          diagnosticMeta: {
            parsedTopLevelKeys: normalizedCandidate.parsedTopLevelKeys,
            missingTopLevelKeys: normalizedCandidate.missingTopLevelKeys,
            validationErrorPath: normalizedCandidate.validationErrorPath,
            validationErrorMessage: normalizedCandidate.validationErrorMessage,
          },
        };
      }
    } catch {
      continue;
    }
  }

  return {
    result: createEmptyOmObserverResult(),
    diagnosticCode: "invalid-output",
  };
}

export async function invokeOmObserver(
  context: OmObserverInvokeContext,
  state: OmStateV1,
  window: OmObserverWindow,
  options: OmObserverInvokeOptions = {}
): Promise<OmObserverResult> {
  if (window.status !== "ready") {
    emitOmObserverDiagnostic(options, "window-not-ready");
    return createEmptyOmObserverResult();
  }

  const model = resolveOmObserverModel(context);
  if (!model) {
    emitOmObserverDiagnostic(options, "missing-model");
    return createEmptyOmObserverResult();
  }

  const modelMeta = {
    model: formatOmObserverModelLabel(model),
  };

  let auth: { apiKey?: string; headers?: Record<string, string> };
  try {
    auth = await getModelAuthOrThrow(context.modelRegistry, model);
  } catch {
    emitOmObserverDiagnostic(options, "auth-failed", modelMeta);
    return createEmptyOmObserverResult();
  }

  const prompt = buildOmObserverPromptForWindow(state, window);
  const runComplete = options.completeFn ?? complete;

  try {
    const response = await runComplete(
      model,
      {
        systemPrompt: OM_OBSERVER_SYSTEM_PROMPT,
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

    const responseSummary = summarizeAssistantResponse(response, model);

    if (response.stopReason === "aborted") {
      emitOmObserverDiagnostic(options, "aborted", responseSummary.meta);
      return createEmptyOmObserverResult();
    }

    if (response.stopReason === "error") {
      emitOmObserverDiagnostic(options, "provider-error", responseSummary.meta);
      return createEmptyOmObserverResult();
    }

    const { result, diagnosticCode, diagnosticMeta } =
      parseOmObserverResultPayload(responseSummary.text);

    if (diagnosticCode) {
      emitOmObserverDiagnostic(options, diagnosticCode, {
        ...responseSummary.meta,
        ...diagnosticMeta,
      });
      return result;
    }

    if (
      result.observations.length === 0 &&
      result.stableFacts.length === 0 &&
      result.activeThreads.length === 0
    ) {
      emitOmObserverDiagnostic(options, "empty-result", responseSummary.meta);
    }

    return result;
  } catch {
    emitOmObserverDiagnostic(options, "completion-error", modelMeta);
    return createEmptyOmObserverResult();
  }
}

export function parseOmObserverResultText(text: unknown): OmObserverResult {
  return parseOmObserverResultPayload(text).result;
}

function normalizeSourceEntryIds(
  pendingEntryIds: readonly string[],
  sourceEntryIds?: readonly string[]
): string[] {
  const allowedEntryIds = new Set(pendingEntryIds);
  const explicitSourceEntryIds =
    sourceEntryIds?.filter((entryId) => allowedEntryIds.has(entryId)) ?? [];

  if (explicitSourceEntryIds.length > 0) {
    return explicitSourceEntryIds;
  }

  return [...pendingEntryIds];
}

function mergeStableFacts(
  currentFacts: readonly OmStableFact[],
  nextFacts: Readonly<OmObserverResult["stableFacts"]>,
  pendingEntryIds: readonly string[],
  updatedAt: string
): OmStableFact[] {
  const mergedFacts = currentFacts.map((fact) => structuredClone(fact));
  const factIndexes = new Map(
    mergedFacts.map((fact, index) => [fact.id, index])
  );

  for (const fact of nextFacts) {
    const normalizedFact: OmStableFact = {
      id: fact.id,
      text: fact.text,
      sourceEntryIds: normalizeSourceEntryIds(
        pendingEntryIds,
        fact.sourceEntryIds
      ),
      updatedAt,
    };
    const factIndex = factIndexes.get(normalizedFact.id);

    if (factIndex === undefined) {
      factIndexes.set(normalizedFact.id, mergedFacts.length);
      mergedFacts.push(normalizedFact);
      continue;
    }

    mergedFacts[factIndex] = normalizedFact;
  }

  return mergedFacts;
}

function mergeActiveThreads(
  currentThreads: readonly OmActiveThread[],
  nextThreads: Readonly<OmObserverResult["activeThreads"]>,
  pendingEntryIds: readonly string[],
  updatedAt: string
): OmActiveThread[] {
  const mergedThreads = currentThreads.map((thread) => structuredClone(thread));
  const threadIndexes = new Map(
    mergedThreads.map((thread, index) => [thread.id, index])
  );

  for (const thread of nextThreads) {
    const normalizedThread: OmActiveThread = {
      id: thread.id,
      title: thread.title,
      status: thread.status,
      sourceEntryIds: normalizeSourceEntryIds(
        pendingEntryIds,
        thread.sourceEntryIds
      ),
      updatedAt,
      ...(thread.summary ? { summary: thread.summary } : {}),
    };
    const threadIndex = threadIndexes.get(normalizedThread.id);

    if (threadIndex === undefined) {
      threadIndexes.set(normalizedThread.id, mergedThreads.length);
      mergedThreads.push(normalizedThread);
      continue;
    }

    mergedThreads[threadIndex] = normalizedThread;
  }

  return mergedThreads;
}

function createObservationId(
  cursorAdvanceEntryId: string | null,
  updatedAt: string,
  index: number
): string {
  return `obs-${cursorAdvanceEntryId ?? "root"}-${updatedAt}-${index + 1}`;
}

function normalizeContinuationHint(
  value: string | undefined
): string | undefined {
  const normalized = normalizeText(value);
  return normalized || undefined;
}

function applyOmContinuationHints(
  state: OmStateV1,
  observerResult: OmObserverResult
): {
  currentTask?: string;
  suggestedNextResponse?: string;
  hasContinuationUpdates: boolean;
} {
  const nextCurrentTask = normalizeContinuationHint(observerResult.currentTask);
  const nextSuggestedNextResponse = normalizeContinuationHint(
    observerResult.suggestedNextResponse
  );
  const currentTask =
    observerResult.currentTask === undefined
      ? state.currentTask
      : (nextCurrentTask ?? state.currentTask);
  const suggestedNextResponse =
    observerResult.suggestedNextResponse === undefined
      ? state.suggestedNextResponse
      : (nextSuggestedNextResponse ?? state.suggestedNextResponse);

  return {
    ...(currentTask ? { currentTask } : {}),
    ...(suggestedNextResponse ? { suggestedNextResponse } : {}),
    hasContinuationUpdates:
      nextCurrentTask !== undefined || nextSuggestedNextResponse !== undefined,
  };
}

export function applyOmObserverResult(
  state: OmStateV1,
  window: OmObserverWindow,
  observerResult: OmObserverResult,
  updatedAt: string
): OmObserverApplyResult {
  const clonedState = structuredClone(state);
  const envelope = createOmStateEnvelope(clonedState, window.branchScope);

  if (window.status === "rebuild") {
    return {
      status: "noop",
      reason: "requires-rebuild",
      state: clonedState,
      envelope,
      shouldPersist: false,
    };
  }

  if (window.status === "duplicate") {
    return {
      status: "duplicate",
      reason: "no-new-entries",
      state: clonedState,
      envelope,
      shouldPersist: false,
    };
  }

  if (window.status === "noop") {
    if (window.reason === "threshold-not-met") {
      return {
        status: "noop",
        reason: "threshold-not-met",
        state: clonedState,
        envelope,
        shouldPersist: false,
      };
    }

    const nextLastProcessedEntryId =
      window.cursorAdvanceEntryId ?? clonedState.lastProcessedEntryId;
    const nextState: OmStateV1 = {
      ...clonedState,
      lastProcessedEntryId: nextLastProcessedEntryId,
      updatedAt,
    };

    return {
      status: "noop",
      reason: "cursor-advanced",
      state: nextState,
      envelope: createOmStateEnvelope(nextState, window.branchScope),
      shouldPersist:
        nextLastProcessedEntryId !== clonedState.lastProcessedEntryId,
    };
  }

  const nextLastProcessedEntryId =
    window.cursorAdvanceEntryId ?? clonedState.lastProcessedEntryId;
  const { hasContinuationUpdates, ...continuationHints } =
    applyOmContinuationHints(clonedState, observerResult);
  const nextObservations = observerResult.observations.map(
    (observation, index) => ({
      id: createObservationId(window.cursorAdvanceEntryId, updatedAt, index),
      kind: observation.kind,
      summary: observation.summary,
      sourceEntryIds: normalizeSourceEntryIds(
        window.pendingEntryIds,
        observation.sourceEntryIds
      ),
      createdAt: updatedAt,
    })
  );
  const nextState: OmStateV1 = {
    ...clonedState,
    ...continuationHints,
    lastProcessedEntryId: nextLastProcessedEntryId,
    observations: [...clonedState.observations, ...nextObservations],
    stableFacts: mergeStableFacts(
      clonedState.stableFacts,
      observerResult.stableFacts,
      window.pendingEntryIds,
      updatedAt
    ),
    activeThreads: mergeActiveThreads(
      clonedState.activeThreads,
      observerResult.activeThreads,
      window.pendingEntryIds,
      updatedAt
    ),
    updatedAt,
  };
  const hasObserverUpdates =
    nextObservations.length > 0 ||
    observerResult.stableFacts.length > 0 ||
    observerResult.activeThreads.length > 0 ||
    hasContinuationUpdates;

  if (!hasObserverUpdates) {
    return {
      status: "noop",
      reason: "cursor-advanced",
      state: nextState,
      envelope: createOmStateEnvelope(nextState, window.branchScope),
      shouldPersist:
        nextLastProcessedEntryId !== clonedState.lastProcessedEntryId,
    };
  }

  return {
    status: "applied",
    reason: "updated-state",
    state: nextState,
    envelope: createOmStateEnvelope(nextState, window.branchScope),
    shouldPersist: true,
  };
}
