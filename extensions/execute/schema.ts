import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

const text = Type.String({ minLength: 1, maxLength: 32_000, pattern: "\\S" });
const id = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-zA-Z0-9_-]+$",
});
const texts = Type.Array(text, { maxItems: 100 });
const nullableText = Type.Union([text, Type.Null()]);
const objectOptions = { additionalProperties: false };

export const WorkerReportSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("done"),
      Type.Literal("blocked"),
      Type.Literal("needs_followup"),
    ]),
    summary: text,
    filesTouched: texts,
    validation: texts,
    followUps: texts,
    blockers: texts,
  },
  objectOptions,
);
export type WorkerReport = Static<typeof WorkerReportSchema>;

export const AssignmentInputSchema = Type.Object(
  {
    id,
    task: text,
    scope: Type.Array(text, { minItems: 1, maxItems: 100 }),
    dependencies: Type.Array(id, { maxItems: 100 }),
  },
  objectOptions,
);
export type AssignmentInput = Static<typeof AssignmentInputSchema>;

const AssignmentSchema = Type.Object(
  {
    ...AssignmentInputSchema.properties,
    lineageId: id,
    repairCount: Type.Integer({ minimum: 0, maximum: 2 }),
    supersededBy: Type.Union([id, Type.Null()]),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("blocked"),
      Type.Literal("completed"),
    ]),
    attemptId: nullableText,
    toolCallId: nullableText,
    runId: nullableText,
    report: Type.Union([WorkerReportSchema, Type.Null()]),
    evidence: texts,
    blockers: texts,
  },
  objectOptions,
);

export const LedgerSchema = Type.Object(
  {
    version: Type.Literal(1),
    sessionId: text,
    invocationId: id,
    plan: nullableText,
    approval: nullableText,
    assignments: Type.Array(AssignmentSchema, { maxItems: 300 }),
  },
  objectOptions,
);
export type ExecutionLedger = Static<typeof LedgerSchema>;
export type Assignment = ExecutionLedger["assignments"][number];

const common = { invocationId: id };
export const CheckpointSchema = Type.Union([
  Type.Object({ ...common, action: Type.Literal("inspect") }, objectOptions),
  Type.Object(
    {
      ...common,
      action: Type.Literal("accept"),
      plan: text,
      approval: text,
      assignments: Type.Array(AssignmentInputSchema, {
        minItems: 1,
        maxItems: 100,
      }),
    },
    objectOptions,
  ),
  Type.Object(
    { ...common, action: Type.Literal("start"), assignmentId: id },
    objectOptions,
  ),
  Type.Object(
    {
      ...common,
      action: Type.Literal("verify"),
      assignmentId: id,
      attemptId: text,
      passed: Type.Boolean(),
      evidence: Type.Array(text, { minItems: 1, maxItems: 100 }),
      blockers: texts,
    },
    objectOptions,
  ),
  Type.Object(
    {
      ...common,
      action: Type.Literal("block"),
      assignmentId: id,
      blockers: Type.Array(text, { minItems: 1, maxItems: 100 }),
    },
    objectOptions,
  ),
  Type.Object(
    {
      ...common,
      action: Type.Literal("repair"),
      assignmentId: id,
      newAssignmentId: id,
      task: text,
    },
    objectOptions,
  ),
  Type.Object({ ...common, action: Type.Literal("stop") }, objectOptions),
]);
export type Checkpoint = Static<typeof CheckpointSchema>;

// Providers require an object root; CheckpointSchema enforces action-specific fields locally.
export const CheckpointParametersSchema = Type.Object(
  {
    ...common,
    action: StringEnum([
      "inspect",
      "accept",
      "start",
      "verify",
      "block",
      "repair",
      "stop",
    ]),
    plan: Type.Optional(text),
    approval: Type.Optional(text),
    assignments: Type.Optional(
      Type.Array(AssignmentInputSchema, { minItems: 1, maxItems: 100 }),
    ),
    assignmentId: Type.Optional(id),
    attemptId: Type.Optional(text),
    passed: Type.Optional(Type.Boolean()),
    evidence: Type.Optional(Type.Array(text, { minItems: 1, maxItems: 100 })),
    blockers: Type.Optional(texts),
    newAssignmentId: Type.Optional(id),
    task: Type.Optional(text),
  },
  objectOptions,
);

export const CheckpointOutputSchema = Type.Object(
  {
    ledger: LedgerSchema,
    dispatchPrefix: Type.Union([text, Type.Null()]),
  },
  objectOptions,
);
