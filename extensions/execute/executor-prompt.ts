import { Type } from "typebox";

import type { TaskShape } from "./task-shape";

export const MAX_EXECUTOR_TASK_PROMPT_LENGTH = 50_000;
export const MAX_EXECUTOR_COMPOSED_PROMPT_LENGTH = 300_000;
const MAX_SUMMARY_LENGTH = 2000;
const MAX_RESULT_FILES = 20;
const MAX_RESULT_LIST_ITEMS = 20;
const MAX_FILE_PATH_LENGTH = 500;
const MAX_RESULT_ITEM_LENGTH = 1000;

const EXECUTOR_TASK_OPEN = "<executor-task>";
const EXECUTOR_TASK_CLOSE = "</executor-task>";
const TDD_WORKFLOW_OPEN = "<trusted-tdd-workflow>";
const TDD_WORKFLOW_CLOSE = "</trusted-tdd-workflow>";
const TASK_SHAPE_OPEN = "<trusted-task-shape>";
const TASK_SHAPE_CLOSE = "</trusted-task-shape>";
const TDD_CHECKLIST_OPEN = "<trusted-tdd-pre-submit-checklist>";
const TDD_CHECKLIST_CLOSE = "</trusted-tdd-pre-submit-checklist>";

const TDD_PRE_SUBMIT_CHECKLIST = [
  TDD_CHECKLIST_OPEN,
  "Finish the complete regression test and every test helper before RED.",
  "If a meaningful behavioral RED is unavailable, report why and use the safest applicable verification strategy; never fabricate RED.",
  "Do not pass `undefined` to a defaulted test-helper parameter to represent absence; use an explicit sentinel.",
  "Never mutate a test file after RED.",
  "Write production edits in final formatted and type-safe form; mutation-capable formatter, lint, and typecheck shell commands do not belong inside the managed RED-to-GREEN window.",
  "Run the declared exact GREEN command after the last production mutation.",
  "After final GREEN, do not mutate the workspace; leave broader lint and type verification to parent orchestration.",
  "For COVERAGE evidence, cite the exact observed passing command or name the covered behavior and failure path.",
  "Add numeric coverage claims only when those exact values appear in retained runner output.",
  TDD_CHECKLIST_CLOSE,
].join("\n");

export const EXECUTOR_RESULT_SCHEMA = Type.Object(
  {
    status: Type.Union([
      Type.Literal("done"),
      Type.Literal("blocked"),
      Type.Literal("needs_followup"),
    ]),
    summary: Type.String({ minLength: 1, maxLength: MAX_SUMMARY_LENGTH }),
    filesTouched: Type.Array(Type.String({ maxLength: MAX_FILE_PATH_LENGTH }), {
      maxItems: MAX_RESULT_FILES,
    }),
    validation: Type.Array(Type.String({ maxLength: MAX_RESULT_ITEM_LENGTH }), {
      maxItems: MAX_RESULT_LIST_ITEMS,
    }),
    followUps: Type.Array(Type.String({ maxLength: MAX_RESULT_ITEM_LENGTH }), {
      maxItems: MAX_RESULT_LIST_ITEMS,
    }),
    blockers: Type.Array(Type.String({ maxLength: MAX_RESULT_ITEM_LENGTH }), {
      maxItems: MAX_RESULT_LIST_ITEMS,
    }),
  },
  { additionalProperties: false }
);

export const EXECUTOR_RESULT_PROMPT = [
  "Call structured_output exactly once as your sole final action with output matching this exact closed schema:",
  JSON.stringify(EXECUTOR_RESULT_SCHEMA),
  "Use needs_followup only when a non-empty blocker prevents completion.",
  "Use done when the requested work is complete; put non-blocking cleanup in followUps.",
  "Do not return the result as assistant text or emit assistant text after structured_output.",
].join("\n");

export function escapeExecutorTaskPrompt(prompt: string): string {
  return prompt
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function composeExecutorPrompt(
  prompt: string,
  promptKind = "executor"
): string {
  const composed = [prompt, "", EXECUTOR_RESULT_PROMPT].join("\n");
  if (composed.length > MAX_EXECUTOR_COMPOSED_PROMPT_LENGTH) {
    throw new Error(
      `Composed ${promptKind} prompt exceeds ${MAX_EXECUTOR_COMPOSED_PROMPT_LENGTH} characters.`
    );
  }
  return composed;
}

function escapeTaskShapeXml(value: string): string {
  return escapeExecutorTaskPrompt(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function composeTrustedTaskShape(shape: TaskShape): string {
  return [
    TASK_SHAPE_OPEN,
    `<behavior>${escapeTaskShapeXml(shape.behavior)}</behavior>`,
    `<red-green-command>${escapeTaskShapeXml(shape.redGreenCommand)}</red-green-command>`,
    `<production-component>${escapeTaskShapeXml(shape.productionComponent)}</production-component>`,
    "<mutation-manifest>",
    ...shape.mutations.map(
      (mutation) =>
        `<mutation kind="${escapeTaskShapeXml(mutation.kind)}"><path>${escapeTaskShapeXml(mutation.path)}</path></mutation>`
    ),
    "</mutation-manifest>",
    "The mutation manifest is the declared slice. If actual work grows, continue toward GREEN; the runtime will report a warning after the Agent settles.",
    TASK_SHAPE_CLOSE,
  ].join("\n");
}

export function composeTddExecutorPrompt(
  taskPrompt: string,
  trustedWorkflow: string,
  trustedShape?: TaskShape
): string {
  const envelope = [
    EXECUTOR_TASK_OPEN,
    escapeExecutorTaskPrompt(taskPrompt),
    EXECUTOR_TASK_CLOSE,
    ...(trustedShape ? [composeTrustedTaskShape(trustedShape)] : []),
    TDD_WORKFLOW_OPEN,
    trustedWorkflow,
    TDD_WORKFLOW_CLOSE,
    TDD_PRE_SUBMIT_CHECKLIST,
  ].join("\n");
  return composeExecutorPrompt(envelope, "TDD executor");
}
