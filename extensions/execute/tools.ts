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
  canonicalPlanHash: Type.Optional(Type.String({ minLength: 1 })),
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
  canonicalPlan: Type.Optional(Type.String({ minLength: 1 })),
  planId: Type.Optional(Type.String({ minLength: 1 })),
  checkpoint: Type.Optional(ExecuteCheckpointSaveSchema),
});

type CheckpointParams = {
  canonicalPlan?: string;
  planId?: string;
};

function jsonResult(details: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(details, null, 2) },
    ],
    details,
  };
}

function errorResult(message: string) {
  return { ...jsonResult({ error: message }), isError: true };
}

function requireCanonicalPlan(
  params: CheckpointParams,
  op: "load" | "save"
): string | { error: string } {
  if (params.planId && !params.canonicalPlan) {
    return {
      error: `planId-only execute_checkpoint ${op} is no longer supported; canonicalPlan is required.`,
    };
  }

  if (!params.canonicalPlan) {
    return { error: `canonicalPlan is required when op is ${op}.` };
  }

  return params.canonicalPlan;
}

function buildSaveResponse(result: {
  path: string;
  created: boolean;
  status: string;
  taskCount: number;
  warnings?: string[];
}) {
  return {
    path: result.path,
    created: result.created,
    status: result.status,
    taskCount: result.taskCount,
    warnings: result.warnings,
  };
}

export function registerExecuteCheckpointTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "execute_checkpoint",
    label: "Execute Checkpoint",
    description:
      "Load, save, or list unfinished /execute checkpoint state under .pi/execute/. Use this from the main-session orchestrator only for deterministic checkpoint persistence; it does not manage pi-tasks or orchestration decisions.",
    parameters: ExecuteCheckpointParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();

      try {
        switch (params.op) {
          case "load": {
            const canonicalPlan = requireCanonicalPlan(params, "load");
            if (typeof canonicalPlan !== "string") {
              return errorResult(canonicalPlan.error);
            }

            return jsonResult(loadExecuteCheckpoint(canonicalPlan, cwd));
          }
          case "save": {
            const canonicalPlan = requireCanonicalPlan(params, "save");
            if (typeof canonicalPlan !== "string") {
              return errorResult(canonicalPlan.error);
            }

            if (!params.checkpoint) {
              return errorResult("checkpoint is required when op is save.");
            }

            return jsonResult(
              buildSaveResponse(
                saveExecuteCheckpoint(
                  canonicalPlan,
                  params.checkpoint,
                  cwd
                )
              )
            );
          }
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
