import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

const text = Type.String({ minLength: 1, maxLength: 32_000, pattern: "\\S" });
const id = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-zA-Z0-9_-]+$",
});
const texts = Type.Array(text, { maxItems: 100 });
// Spec Done Criterion label, e.g. DC-1.
const criterionId = Type.String({ pattern: "^DC-[1-9][0-9]*$" });
const criterionIds = Type.Array(criterionId, { minItems: 1, maxItems: 100 });
const criterionEvidence = Type.Object(
  { id: criterionId, evidence: text },
  { additionalProperties: false },
);
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

const SpecReviewFindingSchema = Type.Object(
  {
    id: text,
    severity: Type.Union([
      Type.Literal("high"),
      Type.Literal("medium"),
      Type.Literal("low"),
    ]),
    target: Type.String({
      pattern: "^(DC-[1-9][0-9]*|US-[1-9][0-9]*|Plan|Scope)$",
    }),
    why: text,
    change: text,
  },
  objectOptions,
);
export const SpecReviewReportSchema = Type.Object(
  {
    findings: Type.Array(SpecReviewFindingSchema, { maxItems: 50 }),
    questions: Type.Array(
      Type.Object(
        {
          id: text,
          question: text,
          options: Type.Array(text, { minItems: 2, maxItems: 4 }),
        },
        objectOptions,
      ),
      { maxItems: 5 },
    ),
  },
  objectOptions,
);
export type SpecReviewReport = Static<typeof SpecReviewReportSchema>;
export type SpecReviewFinding = Static<typeof SpecReviewFindingSchema>;

export const AssignmentInputSchema = Type.Object(
  {
    id,
    task: text,
    scope: Type.Array(text, { minItems: 1, maxItems: 100 }),
    dependencies: Type.Array(id, { maxItems: 100 }),
    // Worker directory; scopes are relative to it. Normalized at accept.
    cwd: Type.Optional(text),
    // Spec Done Criteria this assignment proves; required only with specPath.
    criteria: Type.Optional(criterionIds),
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
      Type.Literal("reverify"),
      Type.Literal("running"),
      Type.Literal("blocked"),
      Type.Literal("completed"),
    ]),
    // Optional so persisted v1 session ledger entries from before Spec support still validate.
    resumed: Type.Optional(Type.Boolean()),
    priorRepairs: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
    attemptId: nullableText,
    toolCallId: nullableText,
    runId: nullableText,
    report: Type.Union([WorkerReportSchema, Type.Null()]),
    evidence: texts,
    // Optional so persisted v1 session ledger entries from before the Done Criterion gate still validate.
    criteriaEvidence: Type.Optional(
      Type.Array(criterionEvidence, { maxItems: 100 }),
    ),
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
    // Optional so persisted v1 session ledger entries from before Spec support still validate.
    specPath: Type.Optional(nullableText),
    // Parsed Spec Done Criterion IDs. Optional so persisted v1 session ledger
    // entries from before the Done Criterion gate still validate.
    specCriteria: Type.Optional(criterionIds),
    assignments: Type.Array(AssignmentSchema, { maxItems: 300 }),
  },
  objectOptions,
);
export type ExecutionLedger = Static<typeof LedgerSchema>;
export type Assignment = ExecutionLedger["assignments"][number];

// Derived by runtime from the Spec log, never supplied by the agent.
export interface SpecResume {
  verified: string[];
  // Unverified lineages with logged progress, keyed to their restored blockers.
  blocked: Record<string, string[]>;
  priorRepairs: Record<string, number>;
}

const common = { invocationId: id };
const verifyCriteria = Type.Array(criterionEvidence, {
  minItems: 1,
  maxItems: 100,
});
// Exactly two distinct single-line reviewer focus statements, no leading or
// trailing whitespace.
const focus = Type.Array(
  Type.String({
    minLength: 1,
    maxLength: 2000,
    pattern: "^\\S(?:[^\\r\\n]*\\S)?$",
  }),
  { minItems: 2, maxItems: 2, uniqueItems: true },
);
export const CheckpointSchema = Type.Union([
  Type.Object({ ...common, action: Type.Literal("inspect") }, objectOptions),
  Type.Object(
    {
      ...common,
      action: Type.Literal("accept"),
      plan: text,
      approval: text,
      specPath: Type.Optional(text),
      reviseSpec: Type.Optional(Type.Boolean()),
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
      attemptId: Type.Optional(text),
      passed: Type.Boolean(),
      evidence: Type.Array(text, { minItems: 1, maxItems: 100 }),
      blockers: texts,
      criteria: Type.Optional(verifyCriteria),
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
  Type.Object(
    { ...common, action: Type.Literal("review"), specPath: text, focus },
    objectOptions,
  ),
  Type.Object(
    { ...common, action: Type.Literal("resolve_review"), specPath: text },
    objectOptions,
  ),
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
      "review",
      "resolve_review",
    ]),
    plan: Type.Optional(text),
    approval: Type.Optional(text),
    specPath: Type.Optional(text),
    reviseSpec: Type.Optional(Type.Boolean()),
    assignments: Type.Optional(
      Type.Array(AssignmentInputSchema, { minItems: 1, maxItems: 100 }),
    ),
    assignmentId: Type.Optional(id),
    attemptId: Type.Optional(text),
    passed: Type.Optional(Type.Boolean()),
    evidence: Type.Optional(Type.Array(text, { minItems: 1, maxItems: 100 })),
    blockers: Type.Optional(texts),
    criteria: Type.Optional(verifyCriteria),
    newAssignmentId: Type.Optional(id),
    task: Type.Optional(text),
    focus: Type.Optional(focus),
  },
  objectOptions,
);

export const CheckpointOutputSchema = Type.Object(
  {
    ledger: LedgerSchema,
    dispatchPrefix: Type.Union([text, Type.Null()]),
    // Spec review round state; review actions never change the ledger.
    review: Type.Optional(
      Type.Object(
        {
          round: Type.Integer({ minimum: 1 }),
          limit: Type.Boolean(),
          note: Type.Optional(text),
          decision: Type.Optional(
            Type.Union([
              Type.Literal("accept"),
              Type.Literal("revise"),
              Type.Literal("stop"),
            ]),
          ),
          answers: Type.Optional(
            Type.Array(
              // id is `<reviewer slot>:<question id>`; question ids are report-scoped.
              Type.Object(
                { id: text, focus: text, question: text, answer: text },
                objectOptions,
              ),
              { maxItems: 10 },
            ),
          ),
          findings: Type.Optional(
            Type.Array(SpecReviewFindingSchema, { maxItems: 100 }),
          ),
        },
        objectOptions,
      ),
    ),
  },
  objectOptions,
);
