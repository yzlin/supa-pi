import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  listUnfinishedExecuteCheckpoints,
  loadExecuteCheckpoint,
  saveExecuteCheckpoint,
} from "./checkpoint";

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

const ExecuteDangerousActionApprovalSchema = Type.Object({
  approved: Type.Boolean(),
  approvedAt: Type.String({ minLength: 1 }),
  reason: Type.Optional(Type.String({ minLength: 1 })),
  planFingerprint: Type.Optional(Type.String({ minLength: 1 })),
});

const ExecuteCheckpointSaveSchema = Type.Object({
  status: Type.String({ minLength: 1 }),
  normalizedSummary: Type.String({ minLength: 1 }),
  tasks: Type.Array(ExecuteCheckpointTaskSchema),
  dangerousActionApproval: Type.Optional(ExecuteDangerousActionApprovalSchema),
});

const ExecuteCheckpointParams = Type.Object({
  op: Type.Union([
    Type.Literal("load"),
    Type.Literal("save"),
    Type.Literal("list_unfinished"),
  ]),
  planId: Type.Optional(Type.String({ minLength: 1 })),
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
      "Load, save, or list unfinished /execute checkpoint state under .pi/execute/. Use this from the main-session orchestrator only for deterministic checkpoint persistence; it does not manage pi-tasks or orchestration decisions.",
    parameters: ExecuteCheckpointParams,

    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();

      try {
        switch (params.op) {
          case "load":
            if (!params.planId) {
              return errorResult("planId is required when op is load.");
            }

            return jsonResult(loadExecuteCheckpoint(params.planId, cwd));
          case "save":
            if (!params.planId) {
              return errorResult("planId is required when op is save.");
            }

            if (!params.checkpoint) {
              return errorResult("checkpoint is required when op is save.");
            }

            return jsonResult(
              buildSaveResponse(
                saveExecuteCheckpoint(params.planId, params.checkpoint, cwd)
              )
            );
          case "list_unfinished":
            return jsonResult(listUnfinishedExecuteCheckpoints(cwd));
        }
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  });
}
