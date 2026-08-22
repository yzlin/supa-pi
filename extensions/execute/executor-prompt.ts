import { Type } from "typebox";

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

export function composeTddExecutorPrompt(
  taskPrompt: string,
  trustedWorkflow: string
): string {
  const envelope = [
    EXECUTOR_TASK_OPEN,
    escapeExecutorTaskPrompt(taskPrompt),
    EXECUTOR_TASK_CLOSE,
    TDD_WORKFLOW_OPEN,
    trustedWorkflow,
    TDD_WORKFLOW_CLOSE,
  ].join("\n");
  return composeExecutorPrompt(envelope, "TDD executor");
}
