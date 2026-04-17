import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { loadExecuteCheckpoint, saveExecuteCheckpoint } from "./checkpoint";

const ExecuteCheckpointTaskSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  subject: Type.String({ minLength: 1 }),
  status: Type.String({ minLength: 1 }),
  blockedBy: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: "Optional list of blocking task ids.",
    })
  ),
});

const ExecuteCheckpointSaveSchema = Type.Object({
  status: Type.String({ minLength: 1 }),
  normalizedSummary: Type.String({ minLength: 1 }),
  tasks: Type.Array(ExecuteCheckpointTaskSchema),
});

const ExecuteCheckpointParams = Type.Object({
  op: Type.Union([Type.Literal("load"), Type.Literal("save")]),
  planId: Type.String({ minLength: 1 }),
  checkpoint: Type.Optional(ExecuteCheckpointSaveSchema),
});

function jsonResult(details: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(details, null, 2) },
    ],
    details,
  };
}

function errorResult(message: string) {
  return jsonResult({ error: message });
}

function buildSaveResponse(result: {
  path: string;
  created: boolean;
  status: string;
  taskCount: number;
}) {
  return {
    path: result.path,
    created: result.created,
    status: result.status,
    taskCount: result.taskCount,
  };
}

export function registerExecuteCheckpointTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "execute_checkpoint",
    label: "Execute Checkpoint",
    description:
      "Load or save /execute checkpoint state under .pi/execute/. Use this from the main-session orchestrator only for deterministic checkpoint persistence; it does not manage pi-tasks or orchestration decisions.",
    parameters: ExecuteCheckpointParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();

      try {
        switch (params.op) {
          case "load":
            return jsonResult(loadExecuteCheckpoint(params.planId, cwd));
          case "save":
            if (!params.checkpoint) {
              return errorResult("checkpoint is required when op is save.");
            }

            return jsonResult(
              buildSaveResponse(
                saveExecuteCheckpoint(params.planId, params.checkpoint, cwd)
              )
            );
        }
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  });
}
