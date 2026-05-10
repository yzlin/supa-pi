import type {
  ReadToolDetails,
  ReadToolInput,
} from "@earendil-works/pi-coding-agent";

export interface ToolDisplayReadDetails extends ReadToolDetails {
  toolDisplay: {
    fullRead: true;
    targetName: string;
    path: string;
    bytes: number;
    ignoredOffset?: number;
    ignoredLimit?: number;
  };
}

export function isToolDisplayReadDetails(
  details: unknown
): details is ToolDisplayReadDetails {
  if (!(details && typeof details === "object")) {
    return false;
  }

  const value = details as { toolDisplay?: { fullRead?: unknown } };
  return value.toolDisplay?.fullRead === true;
}

export function createToolDisplayReadDetails(
  path: string,
  targetName: string,
  bytes: number,
  params: Pick<ReadToolInput, "offset" | "limit">
): ToolDisplayReadDetails {
  const toolDisplay: ToolDisplayReadDetails["toolDisplay"] = {
    fullRead: true,
    targetName,
    path,
    bytes,
  };

  if (params.offset !== undefined) {
    toolDisplay.ignoredOffset = params.offset;
  }

  if (params.limit !== undefined) {
    toolDisplay.ignoredLimit = params.limit;
  }

  return { toolDisplay };
}

export function getToolDisplayReadErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Failed to read full file";
}
