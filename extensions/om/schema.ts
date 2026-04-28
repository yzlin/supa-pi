import { Type } from "typebox";
import { Value } from "typebox/value";

import type {
  OmObservationBufferEnvelopeV1,
  OmObserverResult,
  OmReflectionBufferEnvelopeV1,
  OmReflectorResult,
  OmStateEnvelopeV1,
  OmStateV1,
} from "./types";
import {
  OM_CONTINUATION_MAX_LENGTH,
  OM_OBSERVATION_KINDS,
  OM_STATE_VERSION,
  OM_THREAD_STATUSES,
} from "./version";

const StringListSchema = Type.Array(Type.String(), {
  minItems: 0,
});

const TimestampSchema = Type.String({ minLength: 1 });
const ContinuationHintSchema = Type.String({
  minLength: 1,
  maxLength: OM_CONTINUATION_MAX_LENGTH,
});

function literalUnion(values: readonly string[]) {
  return Type.Union(values.map((value) => Type.Literal(value)));
}

const PositiveIntegerOrFalseSchema = Type.Union([
  Type.Integer({ minimum: 1 }),
  Type.Literal(false),
]);

const PositiveNumberOrFalseSchema = Type.Union([
  Type.Number({ exclusiveMinimum: 0 }),
  Type.Literal(false),
]);

export const OmObservationConfigSnapshotSchema = Type.Object({
  messageTokens: Type.Integer({ minimum: 1 }),
  previousObserverTokens: PositiveIntegerOrFalseSchema,
  bufferTokens: PositiveNumberOrFalseSchema,
  bufferActivation: Type.Number({ exclusiveMinimum: 0 }),
  blockAfter: Type.Number({ minimum: 1 }),
});

export const OmReflectionConfigSnapshotSchema = Type.Object({
  observationTokens: Type.Integer({ minimum: 1 }),
  bufferActivation: Type.Number({ exclusiveMinimum: 0 }),
  blockAfter: Type.Number({ minimum: 1 }),
});

export const OmConfigSnapshotSchema = Type.Object({
  enabled: Type.Boolean(),
  model: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  headerMaxFacts: Type.Integer({ minimum: 1 }),
  headerMaxThreads: Type.Integer({ minimum: 1 }),
  observerMaxTurns: Type.Integer({ minimum: 1 }),
  compactionMaxObservations: Type.Integer({ minimum: 1 }),
  compactionMaxReflections: Type.Integer({ minimum: 1 }),
  reflectionMinObservationCount: Type.Integer({ minimum: 1 }),
  observation: OmObservationConfigSnapshotSchema,
  reflection: OmReflectionConfigSnapshotSchema,
  observationMessageTokens: Type.Integer({ minimum: 1 }),
  observationPreviousTokens: PositiveIntegerOrFalseSchema,
  reflectionObservationTokens: Type.Integer({ minimum: 1 }),
  headerMaxTokens: PositiveIntegerOrFalseSchema,
  compactionMaxTokens: PositiveIntegerOrFalseSchema,
  shareTokenBudget: Type.Boolean(),
});

export const OmStableFactSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  text: Type.String({ minLength: 1 }),
  sourceEntryIds: StringListSchema,
  updatedAt: TimestampSchema,
});

export const OmActiveThreadSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  status: literalUnion(OM_THREAD_STATUSES),
  summary: Type.Optional(Type.String({ minLength: 1 })),
  sourceEntryIds: StringListSchema,
  updatedAt: TimestampSchema,
});

export const OmObservationSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: literalUnion(OM_OBSERVATION_KINDS),
  summary: Type.String({ minLength: 1 }),
  sourceEntryIds: StringListSchema,
  createdAt: TimestampSchema,
});

export const OmObserverResultObservationSchema = Type.Object({
  kind: literalUnion(OM_OBSERVATION_KINDS),
  summary: Type.String({ minLength: 1 }),
  sourceEntryIds: Type.Optional(StringListSchema),
});

export const OmObserverResultFactSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  text: Type.String({ minLength: 1 }),
  sourceEntryIds: Type.Optional(StringListSchema),
});

export const OmObserverResultThreadSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  status: literalUnion(OM_THREAD_STATUSES),
  summary: Type.Optional(Type.String({ minLength: 1 })),
  sourceEntryIds: Type.Optional(StringListSchema),
});

export const OmObserverResultSchema = Type.Object({
  observations: Type.Array(OmObserverResultObservationSchema),
  stableFacts: Type.Array(OmObserverResultFactSchema),
  activeThreads: Type.Array(OmObserverResultThreadSchema),
  currentTask: Type.Optional(ContinuationHintSchema),
  suggestedNextResponse: Type.Optional(ContinuationHintSchema),
});

export const OmReflectionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  summary: Type.String({ minLength: 1 }),
  sourceObservationIds: StringListSchema,
  createdAt: TimestampSchema,
});

export const OmReflectorResultReflectionSchema = Type.Object({
  summary: Type.String({ minLength: 1 }),
  sourceObservationIds: Type.Optional(StringListSchema),
});

export const OmReflectorResultSchema = Type.Object({
  reflections: Type.Array(OmReflectorResultReflectionSchema),
});

export const OmBranchScopeSchema = Type.Object({
  leafId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  entryIds: StringListSchema,
  lastEntryId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
});

export const OmStateV1Schema = Type.Object({
  version: Type.Literal(OM_STATE_VERSION),
  lastProcessedEntryId: Type.Union([
    Type.String({ minLength: 1 }),
    Type.Null(),
  ]),
  observations: Type.Array(OmObservationSchema),
  reflections: Type.Array(OmReflectionSchema),
  stableFacts: Type.Array(OmStableFactSchema),
  activeThreads: Type.Array(OmActiveThreadSchema),
  currentTask: Type.Optional(ContinuationHintSchema),
  suggestedNextResponse: Type.Optional(ContinuationHintSchema),
  configSnapshot: OmConfigSnapshotSchema,
  updatedAt: TimestampSchema,
});

export const OmStateEnvelopeV1Schema = Type.Object({
  version: Type.Literal(OM_STATE_VERSION),
  branchScope: OmBranchScopeSchema,
  state: OmStateV1Schema,
});

const OmBufferStatusSchema = literalUnion([
  "pending",
  "activated",
  "superseded",
]);

export const OmObservationBufferSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Literal("observation"),
  status: OmBufferStatusSchema,
  cursorId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  cursorAdvanceEntryId: Type.Union([
    Type.String({ minLength: 1 }),
    Type.Null(),
  ]),
  sourceEntryIds: StringListSchema,
  messageTokens: Type.Integer({ minimum: 1 }),
  result: OmObserverResultSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const OmReflectionBufferSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Literal("reflection"),
  status: OmBufferStatusSchema,
  sourceObservationIds: StringListSchema,
  observationTokens: Type.Integer({ minimum: 1 }),
  result: OmReflectorResultSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const OmObservationBufferEnvelopeV1Schema = Type.Object({
  version: Type.Literal(OM_STATE_VERSION),
  branchScope: OmBranchScopeSchema,
  buffer: OmObservationBufferSchema,
});

export const OmReflectionBufferEnvelopeV1Schema = Type.Object({
  version: Type.Literal(OM_STATE_VERSION),
  branchScope: OmBranchScopeSchema,
  buffer: OmReflectionBufferSchema,
});

export function isOmStateV1(value: unknown): value is OmStateV1 {
  return Value.Check(OmStateV1Schema, value);
}

export function isOmStateEnvelopeV1(
  value: unknown
): value is OmStateEnvelopeV1 {
  return Value.Check(OmStateEnvelopeV1Schema, value);
}

export function isOmObserverResult(value: unknown): value is OmObserverResult {
  return Value.Check(OmObserverResultSchema, value);
}

function formatTypeBoxErrorPath(path: string): string {
  if (!path || path === "/") {
    return "(root)";
  }

  return path
    .split("/")
    .slice(1)
    .filter((segment) => segment.length > 0)
    .reduce((formattedPath, segment) => {
      const decodedSegment = segment.replace(/~1/g, "/").replace(/~0/g, "~");

      if (/^\d+$/.test(decodedSegment)) {
        return `${formattedPath}[${decodedSegment}]`;
      }

      return formattedPath.length === 0
        ? decodedSegment
        : `${formattedPath}.${decodedSegment}`;
    }, "");
}

type TypeBoxValidationError = {
  path?: string;
  instancePath?: string;
  message?: string;
  keyword?: string;
  params?: {
    limit?: number;
  };
};

function normalizeTypeBoxErrorMessage(error: TypeBoxValidationError): string {
  if (error.keyword === "anyOf") {
    return "Expected union value";
  }

  if (
    error.keyword === "maxLength" &&
    typeof error.params?.limit === "number"
  ) {
    return `Expected string length less or equal to ${error.params.limit}`;
  }

  return error.message ?? "Invalid value";
}

function selectTypeBoxValidationError(
  errors: TypeBoxValidationError[]
): TypeBoxValidationError | null {
  const firstError = errors[0];

  if (!firstError) {
    return null;
  }

  if (firstError.keyword !== "const") {
    return firstError;
  }

  const firstPath = firstError.instancePath ?? firstError.path;

  return (
    errors.find(
      (error) =>
        error.keyword === "anyOf" &&
        (error.instancePath ?? error.path) === firstPath
    ) ?? firstError
  );
}

export function getOmObserverResultValidationError(value: unknown): {
  path: string;
  message: string;
} | null {
  const error = selectTypeBoxValidationError(
    Array.from(Value.Errors(OmObserverResultSchema, value))
  );

  if (!error) {
    return null;
  }

  return {
    path: formatTypeBoxErrorPath(error.path ?? error.instancePath ?? ""),
    message: normalizeTypeBoxErrorMessage(error),
  };
}

export function isOmReflectorResult(
  value: unknown
): value is OmReflectorResult {
  return Value.Check(OmReflectorResultSchema, value);
}

export function isOmObservationBufferEnvelopeV1(
  value: unknown
): value is OmObservationBufferEnvelopeV1 {
  return Value.Check(OmObservationBufferEnvelopeV1Schema, value);
}

export function isOmReflectionBufferEnvelopeV1(
  value: unknown
): value is OmReflectionBufferEnvelopeV1 {
  return Value.Check(OmReflectionBufferEnvelopeV1Schema, value);
}
