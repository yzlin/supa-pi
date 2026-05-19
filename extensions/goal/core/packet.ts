import type { GoalCheckpoint, GoalTask } from "./types";

export interface GoalTaskPacket {
  goalId: string;
  objective: string;
  task: GoalTask;
  checkpointSummary: string;
}

export function buildGoalTaskPacket(
  checkpoint: GoalCheckpoint,
  task: GoalTask
): GoalTaskPacket {
  return {
    goalId: checkpoint.goalId,
    objective: checkpoint.objective,
    task,
    checkpointSummary: `${checkpoint.tasks.length} tasks; status ${checkpoint.status}; updated ${checkpoint.updatedAt}`,
  };
}

export function buildGoalTaskPrompt(packet: GoalTaskPacket): string {
  return [
    `You are executing goal task ${packet.task.id}: ${packet.task.title}`,
    "",
    `Goal: ${packet.objective}`,
    `Checkpoint: ${packet.checkpointSummary}`,
    `Budget: attempts ${packet.task.budget.usedAttempts}/${packet.task.budget.maxAttempts}; tool calls ${packet.task.budget.usedToolCalls}/${packet.task.budget.maxToolCalls ?? "unlimited"}`,
    "",
    "Stay in scope. Return strict executor JSON with status, summary, filesTouched, validation, followUps, blockers.",
  ].join("\n");
}
