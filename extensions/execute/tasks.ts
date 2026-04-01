import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

import {
  EXECUTE_TASK_RPC_TIMEOUT_MS,
  EXECUTE_TASK_SOURCE,
  MAX_WAVES,
} from "./constants";
import type {
  ExecuteRpcContextPayload,
  ExecuteTaskCreateInput,
  ExecuteTaskSnapshot,
  ExecuteTasksBridge,
  ExecuteTaskUpdateResult,
} from "./types";

type ExecuteRpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

const executeRpcCall = <T>(
  pi: ExtensionAPI,
  channel: string,
  params: Record<string, unknown>,
  timeoutMs = EXECUTE_TASK_RPC_TIMEOUT_MS
): Promise<T> => {
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`${channel} timeout`));
    }, timeoutMs);
    const unsubscribe = pi.events.on(
      `${channel}:reply:${requestId}`,
      (raw: unknown) => {
        unsubscribe();
        clearTimeout(timer);
        const reply = raw as ExecuteRpcReply<T>;
        if (reply.success) {
          resolve(reply.data as T);
          return;
        }
        reject(new Error(reply.error));
      }
    );
    pi.events.emit(channel, { requestId, ...params });
  });
};

export const buildExecuteMetadata = (
  executionId: string,
  metadata?: Record<string, unknown>
): Record<string, unknown> => ({
  source: EXECUTE_TASK_SOURCE,
  executionId,
  ...metadata,
});

export const buildExecuteItemActiveForm = (item: string): string =>
  `Executing: ${item}`;

export const buildExecuteItemDescription = (
  item: string,
  index: number,
  total: number
): string => [`Plan item ${index + 1}/${total}`, "", item].join("\n");

export const buildFollowUpDescription = (
  item: string,
  parentItem: string
): string =>
  [
    "Follow-up work discovered during /execute-wave",
    "",
    item,
    "",
    `Parent item: ${parentItem}`,
  ].join("\n");

export const buildBlockerDescription = (
  item: string,
  reason: string
): string => [`Blocked while executing: ${item}`, "", reason].join("\n");

export const buildRemainingFollowUpsDescription = (count: number): string =>
  `Stopped after ${MAX_WAVES} waves with ${count} item(s) still queued`;

export const createExecuteTasksBridge = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext
): Promise<ExecuteTasksBridge | null> => {
  const rpcContext: ExecuteRpcContextPayload = {
    uiCtx: ctx.ui,
    sessionId: ctx.sessionManager.getSessionId(),
  };
  const withRpcContext = (
    params: Record<string, unknown>
  ): Record<string, unknown> => ({
    ...params,
    ...rpcContext,
  });

  try {
    await executeRpcCall<{ version?: string | number }>(
      pi,
      "tasks:rpc:ping",
      withRpcContext({})
    );
  } catch {
    return null;
  }

  const callIfAvailable = async <T>(
    fn: () => Promise<T>
  ): Promise<T | undefined> => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };

  return {
    isAvailable: () => true,
    createTask: async (input) =>
      await callIfAvailable(() =>
        executeRpcCall<ExecuteTaskSnapshot>(
          pi,
          "tasks:rpc:create",
          withRpcContext(input)
        )
      ),
    updateTask: async (input) =>
      await callIfAvailable(() =>
        executeRpcCall<ExecuteTaskUpdateResult>(
          pi,
          "tasks:rpc:update",
          withRpcContext(input)
        )
      ),
    setTaskActive: async (taskId, active) => {
      const result = await callIfAvailable(() =>
        executeRpcCall<{ taskId: string; active: boolean }>(
          pi,
          "tasks:rpc:set-active",
          withRpcContext({ taskId, active })
        )
      );
      return Boolean(result?.taskId);
    },
  };
};
