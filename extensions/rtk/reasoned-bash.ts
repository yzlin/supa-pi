import type {
  createBashTool,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REASONING_DESCRIPTION =
  "State short present-tense intent, maximum 12 words, without restating target";
const REASONING_GUIDELINE =
  "Give bash a short present-tense reasoning goal without repeating its command";

type BashSchema = ReturnType<typeof createBashTool>["parameters"];

/** Add required intent and elapsed metadata without owning any renderers. */
export function withReasonedBash(tool: ToolDefinition<BashSchema>) {
  const {
    renderShell: _renderShell,
    renderCall: _renderCall,
    renderResult: _renderResult,
    ...executionTool
  } = tool;
  const parameters = Type.Object({
    reasoning: Type.String({ description: REASONING_DESCRIPTION }),
    ...tool.parameters.properties,
  });

  return {
    ...executionTool,
    parameters,
    promptGuidelines: [...(tool.promptGuidelines ?? []), REASONING_GUIDELINE],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { reasoning: _reasoning, ...delegated } = params;
      const startedAt = Date.now();
      const result = await tool.execute(
        toolCallId,
        delegated,
        signal,
        onUpdate,
        ctx,
      );
      const priorDetails =
        result.details && typeof result.details === "object"
          ? (result.details as Record<string, unknown>)
          : {};
      const priorNamespace =
        priorDetails.toolDisplay && typeof priorDetails.toolDisplay === "object"
          ? (priorDetails.toolDisplay as Record<string, unknown>)
          : {};
      return {
        ...result,
        details: {
          ...priorDetails,
          toolDisplay: {
            ...priorNamespace,
            durationMs: Date.now() - startedAt,
          },
        },
      };
    },
  } satisfies ToolDefinition<typeof parameters>;
}
