// Apache-2.0 adaptation of mitsuhiko/agent-stuff, d265b8e. Modified for SupaPi: thin optional-role tool over the reusable runner.
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { THINKING_LEVELS } from "./agents";
import { ATTACH_FLAG, attachFromCli } from "./attach";
import {
  cancelSessionSubagents,
  runSubagent,
  type SubagentResult,
  type SubagentUpdate,
} from "./runner";

const parameters = Type.Object(
  {
    task: Type.String({
      minLength: 1,
      description: "Self-contained task; parent history is not copied",
    }),
    agent: Type.Optional(
      Type.String({
        description:
          "Role name; trusted project .pi/agents shadows global agents; invalid or unknown names fail",
      }),
    ),
    cwd: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
    schema: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Final report JSON Schema; references unsupported",
      }),
    ),
  },
  { additionalProperties: false },
);
const outputSchema = Type.Object(
  {
    runId: Type.String(),
    agent: Type.Optional(Type.String()),
    provider: Type.String(),
    model: Type.String(),
    thinking: Type.String(),
    output: Type.String(),
    structuredOutput: Type.Optional(Type.Unknown()),
    resultPath: Type.String(),
    sessionFile: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export default function subagentExtension(pi: ExtensionAPI): void {
  if (process.env.SUPA_PI_SUBAGENT_CONFIG) {
    return;
  }
  pi.registerFlag(ATTACH_FLAG, {
    description: "Attach to a live subagent by its printed run id",
    type: "string",
  });
  // CLI values are unavailable during factory loading; exit before parent TUI startup.
  attachFromCli();
  pi.on("session_shutdown", async (_event, ctx) => {
    await cancelSessionSubagents(ctx.sessionManager.getSessionId());
  });
  pi.registerTool<typeof parameters, SubagentResult | SubagentUpdate>({
    name: "subagent",
    label: "Subagent",
    description:
      "Run one fresh Pi child in tmux and wait. Four shared slots per parent; extra calls queue. Shared checkout: parallel writes need disjoint scopes. Call settings override role defaults, then parent defaults. Abort stops owned work, not prior edits. Private evidence persists; finished sessions close.",
    promptSnippet: "Delegate one task",
    parameters,
    outputSchema,
    executionMode: "parallel",
    async execute(_id, params, signal, onUpdate, ctx) {
      const result = await runSubagent(pi, ctx, params, {
        signal,
        onUpdate: (update) =>
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `${update.status}: ${update.runId}\n${update.attachCommand ?? ""}\n${update.text}`,
              },
            ],
            details: update,
          }),
      });
      const structuredContent = {
        runId: result.runId,
        provider: result.provider,
        model: result.model,
        thinking: result.thinking,
        output: result.output,
        resultPath: result.resultPath,
        ...(result.agent ? { agent: result.agent } : {}),
        ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
        ...(result.structuredOutput === undefined
          ? {}
          : { structuredOutput: result.structuredOutput }),
      };
      return {
        content: [
          {
            type: "text",
            text: `Subagent completed: ${result.runId}\nModel: ${result.provider}/${result.model} (${result.thinking})\nEvidence: ${result.resultPath}${result.sessionFile ? `\nChild session: ${result.sessionFile}` : ""}\n\n${result.output || (result.structuredOutput === undefined ? "(no text output)" : "Validated StructuredOutput saved in evidence.")}`,
          },
        ],
        details: result,
        structuredContent,
      };
    },
  });
}
