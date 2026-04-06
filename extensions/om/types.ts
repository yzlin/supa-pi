import type {
  OM_OBSERVATION_KINDS,
  OM_STATE_VERSION,
  OM_THREAD_STATUSES,
} from "./version";

export type OmObservationKind = (typeof OM_OBSERVATION_KINDS)[number];
export type OmStateVersion = typeof OM_STATE_VERSION;
export type OmThreadStatus = (typeof OM_THREAD_STATUSES)[number];

export interface OmObservationConfigSnapshot {
  messageTokens: number;
  previousObserverTokens: number | false;
  bufferTokens: number | false;
  bufferActivation: number;
  blockAfter: number;
}

export interface OmReflectionConfigSnapshot {
  observationTokens: number;
  bufferActivation: number;
  blockAfter: number;
}

export interface OmConfigSnapshot {
  enabled: boolean;
  headerMaxFacts: number;
  headerMaxThreads: number;
  observerMaxTurns: number;
  compactionMaxObservations: number;
  compactionMaxReflections: number;
  reflectionMinObservationCount: number;
  observation: OmObservationConfigSnapshot;
  reflection: OmReflectionConfigSnapshot;
  observationMessageTokens: number;
  observationPreviousTokens: number | false;
  reflectionObservationTokens: number;
  headerMaxTokens: number | false;
  compactionMaxTokens: number | false;
  shareTokenBudget: boolean;
}

export interface OmConfigInput
  extends Partial<Omit<OmConfigSnapshot, "observation" | "reflection">> {
  observation?: Partial<OmObservationConfigSnapshot> | Record<string, unknown>;
  reflection?: Partial<OmReflectionConfigSnapshot> | Record<string, unknown>;
}

export interface OmStableFact {
  id: string;
  text: string;
  sourceEntryIds: string[];
  updatedAt: string;
}

export interface OmActiveThread {
  id: string;
  title: string;
  status: OmThreadStatus;
  summary?: string;
  sourceEntryIds: string[];
  updatedAt: string;
}

export interface OmObservation {
  id: string;
  kind: OmObservationKind;
  summary: string;
  sourceEntryIds: string[];
  createdAt: string;
}

export interface OmReflection {
  id: string;
  summary: string;
  sourceObservationIds: string[];
  createdAt: string;
}

export interface OmBranchScope {
  leafId: string | null;
  entryIds: string[];
  lastEntryId: string | null;
}

export interface OmStateV1 {
  version: OmStateVersion;
  lastProcessedEntryId: string | null;
  observations: OmObservation[];
  reflections: OmReflection[];
  stableFacts: OmStableFact[];
  activeThreads: OmActiveThread[];
  configSnapshot: OmConfigSnapshot;
  updatedAt: string;
}

export interface OmRecentEvent {
  createdAt: string;
  level: "info" | "warning" | "error" | "success";
  message: string;
}

export interface OmStateEnvelopeV1 {
  version: OmStateVersion;
  branchScope: OmBranchScope;
  state: OmStateV1;
}

export interface OmBranchDelta<TEntry extends { id: string } = { id: string }> {
  cursorId: string | null;
  cursorFound: boolean;
  requiresRebuild: boolean;
  pendingEntries: TEntry[];
}

export interface OmPromptTurn {
  id: string;
  role: string;
  text: string;
}

export interface OmHeaderInput {
  stableFacts: OmStableFact[];
  activeThreads: OmActiveThread[];
  configSnapshot: OmConfigSnapshot;
}

export interface OmObserverPromptInput extends OmHeaderInput {
  branchScope: OmBranchScope;
  lastProcessedEntryId: string | null;
  previousObservations: OmObservation[];
  newTurns: OmPromptTurn[];
}

export interface OmObserverResultObservation {
  kind: OmObservationKind;
  summary: string;
  sourceEntryIds?: string[];
}

export interface OmObserverResultFact {
  id: string;
  text: string;
  sourceEntryIds?: string[];
}

export interface OmObserverResultThread {
  id: string;
  title: string;
  status: OmThreadStatus;
  summary?: string;
  sourceEntryIds?: string[];
}

export interface OmObserverResult {
  observations: OmObserverResultObservation[];
  stableFacts: OmObserverResultFact[];
  activeThreads: OmObserverResultThread[];
}

export interface OmObserverWindow<
  TEntry extends { id: string } = { id: string },
> {
  status: "ready" | "noop" | "duplicate" | "rebuild";
  reason:
    | "new-turns"
    | "block-after"
    | "threshold-not-met"
    | "no-completed-turns"
    | "no-new-entries"
    | "missing-cursor";
  branchScope: OmBranchScope;
  delta: OmBranchDelta<TEntry>;
  pendingEntryIds: string[];
  newTurns: OmPromptTurn[];
  cursorAdvanceEntryId: string | null;
}

export interface OmObserverApplyResult {
  status: "applied" | "noop" | "duplicate";
  reason:
    | "updated-state"
    | "threshold-not-met"
    | "cursor-advanced"
    | "no-new-entries"
    | "requires-rebuild";
  state: OmStateV1;
  envelope: OmStateEnvelopeV1;
  shouldPersist: boolean;
}

export interface OmReflectorResultReflection {
  summary: string;
  sourceObservationIds?: string[];
}

export interface OmReflectorResult {
  reflections: OmReflectorResultReflection[];
}

export interface OmReflectorWindow {
  status: "ready" | "noop";
  reason:
    | "threshold-not-met"
    | "no-observations-to-reflect"
    | "ready"
    | "block-after";
  observationsToReflect: OmObservation[];
  retainedObservations: OmObservation[];
}

export interface OmReflectorApplyResult {
  status: "applied" | "noop";
  reason: "reflected" | "threshold-not-met" | "no-observations-to-reflect";
  state: OmStateV1;
  envelope: OmStateEnvelopeV1;
  shouldPersist: boolean;
}

export interface OmReflectorPromptInput extends OmHeaderInput {
  observations: OmObservation[];
  reflections: OmReflection[];
}

export interface OmCompactionPayloadInput extends OmHeaderInput {
  observations: OmObservation[];
  reflections: OmReflection[];
}

export type OmBufferStatus = "pending" | "activated" | "superseded";

export interface OmObservationBuffer {
  id: string;
  kind: "observation";
  status: OmBufferStatus;
  cursorId: string | null;
  cursorAdvanceEntryId: string | null;
  sourceEntryIds: string[];
  messageTokens: number;
  result: OmObserverResult;
  createdAt: string;
  updatedAt: string;
}

export interface OmReflectionBuffer {
  id: string;
  kind: "reflection";
  status: OmBufferStatus;
  sourceObservationIds: string[];
  observationTokens: number;
  result: OmReflectorResult;
  createdAt: string;
  updatedAt: string;
}

export interface OmObservationBufferEnvelopeV1 {
  version: OmStateVersion;
  branchScope: OmBranchScope;
  buffer: OmObservationBuffer;
}

export interface OmReflectionBufferEnvelopeV1 {
  version: OmStateVersion;
  branchScope: OmBranchScope;
  buffer: OmReflectionBuffer;
}
