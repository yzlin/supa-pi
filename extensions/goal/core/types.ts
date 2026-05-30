export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "budget_limited"
  | "complete"
  | "cleared";

export type GoalMode = "classic" | "task";

export type GoalCommandAction =
  | "start"
  | "resume"
  | "status"
  | "pause"
  | "clear"
  | "stop"
  | "statusbar";

export type GoalTaskStatus =
  | "pending"
  | "active"
  | "blocked"
  | "budget_limited"
  | "complete";

export interface GoalTask {
  id: string;
  title: string;
  status: GoalTaskStatus;
  attempts: number;
  budget: GoalTaskBudget;
  notes?: string[];
}

export interface GoalTaskBudget {
  maxAttempts: number;
  usedAttempts: number;
  maxToolCalls?: number;
  usedToolCalls: number;
}

export interface GoalMilestone {
  id: string;
  title: string;
  status: GoalTaskStatus;
}

export interface GoalEvidenceEntry {
  taskId?: string;
  summary: string;
  filesTouched: string[];
  validation: string[];
  risks: string[];
}

export interface GoalBlockerState {
  blocked: boolean;
  reason: string | null;
  taskId?: string;
}

export type GoalExecutorStatus =
  | "done"
  | "blocked"
  | "needs_followup"
  | "failed";

export interface GoalExecutorSummary {
  taskId?: string;
  status: GoalExecutorStatus;
  summary: string;
  filesTouched: string[];
  validation: string[];
  followUps: string[];
  blockers: string[];
  evidence: string[];
  risks: string[];
  suggestedNextTask: string | null;
}

export interface GoalCheckpointPatch {
  status?: GoalStatus;
  currentMilestone?: string | null;
  coarsePlan?: string[];
  candidateFollowups?: string[];
  blockerState?: GoalBlockerState;
}

export interface GoalCheckpoint {
  version: 1;
  goalId: string;
  status: GoalStatus;
  mode: GoalMode;
  objective: string;
  normalizedObjective: string;
  createdAt: string;
  updatedAt: string;
  coarsePlan: string[];
  milestones: GoalMilestone[];
  currentMilestone: string | null;
  taskBudget: number | null;
  attemptsUsed: number;
  evidenceLedger: GoalEvidenceEntry[];
  candidateFollowups: string[];
  blockerState: GoalBlockerState;
  dirtyBaseline: DirtyBaseline;
  executorSummaries: GoalExecutorSummary[];
  tasks: GoalTask[];
}

export interface DirtyBaseline {
  gitHead: string | null;
  dirtyFiles: string[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
