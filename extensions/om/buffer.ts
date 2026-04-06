import { createOmBranchScope, diffOmBranchEntriesSince } from "./branch";
import { estimateOmObservationTokens, estimateOmTurnTokens } from "./tokens";
import type {
  OmConfigSnapshot,
  OmObservation,
  OmObservationBuffer,
  OmObservationBufferEnvelopeV1,
  OmObserverResult,
  OmObserverWindow,
  OmPromptTurn,
  OmReflectionBuffer,
  OmReflectionBufferEnvelopeV1,
  OmReflectorResult,
  OmReflectorWindow,
  OmStateV1,
} from "./types";
import {
  OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
  OM_REFLECTION_BUFFER_CUSTOM_TYPE,
  OM_STATE_CUSTOM_TYPE,
  OM_STATE_VERSION,
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
  const type = normalizeText(record.type);

  if (type === "text") {
    return normalizeText(record.text);
  }

  if (type === "tool-call" || type === "toolCall") {
    const name = normalizeText(record.name);
    return name ? `tool call: ${name}` : "";
  }

  if (type === "image") {
    return formatAttachmentPlaceholder("Image", record);
  }

  if (type === "file") {
    return formatAttachmentPlaceholder("File", record);
  }

  return "";
}

function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    const text = normalizeText(content);
    return text ? [text] : [];
  }

  if (!Array.isArray(content)) {
    const text =
      extractContentPartText(content) || normalizeText(asRecord(content).text);
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

function serializeObserverEntry<TEntry extends OmObserverEntryLike>(
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

function isOmOwnedCustomEntry(entry: { type?: string; customType?: string }) {
  return (
    entry.type === "custom" &&
    [
      OM_STATE_CUSTOM_TYPE,
      OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
      OM_REFLECTION_BUFFER_CUSTOM_TYPE,
    ].includes(entry.customType ?? "")
  );
}

function sumTurnTokens(turns: readonly OmPromptTurn[]): number {
  return turns.reduce(
    (totalTokens, turn) => totalTokens + estimateOmTurnTokens(turn),
    0
  );
}

function sumObservationTokens(observations: readonly OmObservation[]): number {
  return observations.reduce(
    (totalTokens, observation) =>
      totalTokens + estimateOmObservationTokens(observation),
    0
  );
}

export function hasOmObserverBufferPayload(result: OmObserverResult): boolean {
  return (
    result.observations.length > 0 ||
    result.stableFacts.length > 0 ||
    result.activeThreads.length > 0
  );
}

export function hasOmReflectorBufferPayload(
  result: OmReflectorResult
): boolean {
  return result.reflections.length > 0;
}

export function resolveOmBufferTokens(
  bufferTokens: number | false,
  thresholdTokens: number
): number | false {
  if (bufferTokens === false) {
    return false;
  }

  if (bufferTokens < 1) {
    return Math.max(1, Math.ceil(thresholdTokens * bufferTokens));
  }

  return Math.max(1, Math.trunc(bufferTokens));
}

function resolveObservationTailTokens(
  configSnapshot: OmConfigSnapshot
): number {
  return Math.max(
    0,
    Math.ceil(
      configSnapshot.observation.messageTokens *
        Math.max(0, 1 - configSnapshot.observation.bufferActivation)
    )
  );
}

function takeTailTurnsWithinBudget(
  turns: readonly OmPromptTurn[],
  maxTokens: number
) {
  if (maxTokens <= 0) {
    return [] as OmPromptTurn[];
  }

  const selectedTurns: OmPromptTurn[] = [];
  let selectedTokens = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnTokens = estimateOmTurnTokens(turn);

    if (selectedTokens + turnTokens > maxTokens) {
      break;
    }

    selectedTokens += turnTokens;
    selectedTurns.unshift(turn);
  }

  return selectedTurns;
}

function retainNewestObservationsWithinBudget(
  observations: readonly OmObservation[],
  maxTokens: number
): OmObservation[] {
  if (maxTokens <= 0) {
    return [];
  }

  const retainedObservations: OmObservation[] = [];
  let retainedTokens = 0;

  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index];
    const observationTokens = estimateOmObservationTokens(observation);

    if (
      retainedObservations.length > 0 &&
      retainedTokens + observationTokens > maxTokens
    ) {
      break;
    }

    retainedObservations.unshift(observation);
    retainedTokens += observationTokens;
  }

  return retainedObservations;
}

export function createOmObservationBufferWindow<
  TEntry extends OmObserverEntryLike,
>(
  branchEntries: readonly TEntry[],
  lastProcessedEntryId: string | null,
  configSnapshot: OmConfigSnapshot
): OmObserverWindow<TEntry> | null {
  const delta = diffOmBranchEntriesSince(branchEntries, lastProcessedEntryId);
  if (delta.requiresRebuild) {
    return null;
  }

  const pendingEntries = delta.pendingEntries.filter(
    (entry) => !isOmOwnedCustomEntry(entry)
  );
  const serializedTurns = pendingEntries
    .map((entry) => serializeObserverEntry(entry))
    .filter((turn): turn is OmPromptTurn => Boolean(turn));
  const bufferStep = resolveOmBufferTokens(
    configSnapshot.observation.bufferTokens,
    configSnapshot.observation.messageTokens
  );

  if (bufferStep === false || serializedTurns.length === 0) {
    return null;
  }

  const totalTurnTokens = sumTurnTokens(serializedTurns);
  if (totalTurnTokens < bufferStep) {
    return null;
  }

  const tailTurns = takeTailTurnsWithinBudget(
    serializedTurns,
    resolveObservationTailTokens(configSnapshot)
  );

  if (tailTurns.length === 0) {
    return null;
  }

  const splitIndex = serializedTurns.length - tailTurns.length;
  const sourceTurns = serializedTurns.slice(0, splitIndex);

  if (sourceTurns.length === 0) {
    return null;
  }

  return {
    status: "ready",
    reason: "new-turns",
    branchScope: createOmBranchScope(branchEntries),
    delta,
    pendingEntryIds: sourceTurns.map((turn) => turn.id),
    newTurns: sourceTurns,
    cursorAdvanceEntryId: sourceTurns.at(-1)?.id ?? null,
  };
}

function createObservationBufferId(window: OmObserverWindow): string {
  return `obs-buffer-${window.delta.cursorId ?? "root"}-${window.cursorAdvanceEntryId ?? "root"}`;
}

export function createOmObservationBufferEnvelope(
  window: OmObserverWindow,
  result: OmObserverResult,
  createdAt: string
): OmObservationBufferEnvelopeV1 {
  return {
    version: OM_STATE_VERSION,
    branchScope: structuredClone(window.branchScope),
    buffer: {
      id: createObservationBufferId(window),
      kind: "observation",
      status: "pending",
      cursorId: window.delta.cursorId,
      cursorAdvanceEntryId: window.cursorAdvanceEntryId,
      sourceEntryIds: [...window.pendingEntryIds],
      messageTokens: sumTurnTokens(window.newTurns),
      result: structuredClone(result),
      createdAt,
      updatedAt: createdAt,
    },
  };
}

export function updateOmObservationBufferStatus(
  envelope: OmObservationBufferEnvelopeV1,
  status: OmObservationBuffer["status"],
  updatedAt: string
): OmObservationBufferEnvelopeV1 {
  return {
    version: envelope.version,
    branchScope: structuredClone(envelope.branchScope),
    buffer: {
      ...structuredClone(envelope.buffer),
      status,
      updatedAt,
    },
  };
}

export function canActivateOmObservationBuffer(
  state: OmStateV1,
  envelope: OmObservationBufferEnvelopeV1 | null,
  window: OmObserverWindow
): boolean {
  if (!envelope || window.status !== "ready") {
    return false;
  }

  return (
    envelope.buffer.status === "pending" &&
    envelope.buffer.cursorId === state.lastProcessedEntryId &&
    envelope.buffer.sourceEntryIds.length > 0 &&
    envelope.buffer.sourceEntryIds.every(
      (entryId, index) => window.pendingEntryIds[index] === entryId
    )
  );
}

export function createOmObservationActivationWindow(
  buffer: OmObservationBufferEnvelopeV1,
  window: OmObserverWindow
): OmObserverWindow {
  return {
    ...window,
    pendingEntryIds: [...buffer.buffer.sourceEntryIds],
    newTurns: window.newTurns.filter((turn) =>
      buffer.buffer.sourceEntryIds.includes(turn.id)
    ),
    cursorAdvanceEntryId: buffer.buffer.cursorAdvanceEntryId,
  };
}

export function createOmReflectionBufferWindow(
  state: OmStateV1
): OmReflectorWindow | null {
  if (state.observations.length === 0) {
    return null;
  }

  const activationThreshold = Math.max(
    1,
    Math.ceil(
      state.configSnapshot.reflection.observationTokens *
        state.configSnapshot.reflection.bufferActivation
    )
  );

  if (sumObservationTokens(state.observations) < activationThreshold) {
    return null;
  }

  const retainedObservations = retainNewestObservationsWithinBudget(
    state.observations,
    activationThreshold
  );
  const splitIndex = Math.max(
    0,
    state.observations.length - retainedObservations.length
  );
  const observationsToReflect = state.observations.slice(0, splitIndex);

  if (observationsToReflect.length === 0) {
    return null;
  }

  return {
    status: "ready",
    reason: "ready",
    observationsToReflect,
    retainedObservations,
  };
}

function createReflectionBufferId(window: OmReflectorWindow): string {
  const firstObservationId = window.observationsToReflect[0]?.id ?? "root";
  const lastObservationId = window.observationsToReflect.at(-1)?.id ?? "root";
  return `refl-buffer-${firstObservationId}-${lastObservationId}`;
}

export function createOmReflectionBufferEnvelope(
  state: OmStateV1,
  window: OmReflectorWindow,
  result: OmReflectorResult,
  createdAt: string
): OmReflectionBufferEnvelopeV1 {
  return {
    version: OM_STATE_VERSION,
    branchScope: {
      leafId: state.lastProcessedEntryId,
      entryIds: [],
      lastEntryId: state.lastProcessedEntryId,
    },
    buffer: {
      id: createReflectionBufferId(window),
      kind: "reflection",
      status: "pending",
      sourceObservationIds: window.observationsToReflect.map(
        (observation) => observation.id
      ),
      observationTokens: sumObservationTokens(window.observationsToReflect),
      result: structuredClone(result),
      createdAt,
      updatedAt: createdAt,
    },
  };
}

export function updateOmReflectionBufferStatus(
  envelope: OmReflectionBufferEnvelopeV1,
  status: OmReflectionBuffer["status"],
  updatedAt: string
): OmReflectionBufferEnvelopeV1 {
  return {
    version: envelope.version,
    branchScope: structuredClone(envelope.branchScope),
    buffer: {
      ...structuredClone(envelope.buffer),
      status,
      updatedAt,
    },
  };
}

export function canActivateOmReflectionBuffer(
  envelope: OmReflectionBufferEnvelopeV1 | null,
  window: OmReflectorWindow
): boolean {
  if (!envelope || window.status !== "ready") {
    return false;
  }

  return (
    envelope.buffer.status === "pending" &&
    envelope.buffer.sourceObservationIds.length > 0 &&
    envelope.buffer.sourceObservationIds.every(
      (observationId, index) =>
        window.observationsToReflect[index]?.id === observationId
    )
  );
}

export function createOmReflectionActivationWindow(
  state: OmStateV1,
  buffer: OmReflectionBufferEnvelopeV1
): OmReflectorWindow {
  const splitIndex = buffer.buffer.sourceObservationIds.length;

  return {
    status: "ready",
    reason: "ready",
    observationsToReflect: state.observations.slice(0, splitIndex),
    retainedObservations: state.observations.slice(splitIndex),
  };
}
