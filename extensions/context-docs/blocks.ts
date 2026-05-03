export type MarkedBlockAction = "append" | "error" | "noop" | "replace";

export interface MarkedBlockPlan {
  action: MarkedBlockAction;
  content: string;
  startMarker: string;
  endMarker: string;
  error?: string;
}

export function buildContextDocsBlockMarkers(name: string): {
  startMarker: string;
  endMarker: string;
} {
  return {
    startMarker: `<!-- context-docs:start ${name} -->`,
    endMarker: `<!-- context-docs:end ${name} -->`,
  };
}

function buildMalformedBlockPlan(
  content: string,
  startMarker: string,
  endMarker: string,
  error: string
): MarkedBlockPlan {
  return {
    action: "error",
    content,
    startMarker,
    endMarker,
    error,
  };
}

export function planMarkedBlockUpdate(
  existingContent: string,
  name: string,
  nextBody: string
): MarkedBlockPlan {
  const { startMarker, endMarker } = buildContextDocsBlockMarkers(name);
  const normalizedBody = nextBody.trim();
  const nextBlock = `${startMarker}\n${normalizedBody}\n${endMarker}`;
  const start = existingContent.indexOf(startMarker);
  const end = existingContent.indexOf(endMarker);
  const hasStart = start >= 0;
  const hasEnd = end >= 0;

  if (hasStart && !hasEnd) {
    return buildMalformedBlockPlan(
      existingContent,
      startMarker,
      endMarker,
      `Malformed managed block: missing end marker for ${name}.`
    );
  }

  if (!hasStart && hasEnd) {
    return buildMalformedBlockPlan(
      existingContent,
      startMarker,
      endMarker,
      `Malformed managed block: missing start marker for ${name}.`
    );
  }

  if (hasStart && hasEnd && end < start) {
    return buildMalformedBlockPlan(
      existingContent,
      startMarker,
      endMarker,
      `Malformed managed block: end marker appears before start marker for ${name}.`
    );
  }

  if (hasStart) {
    const endExclusive = end + endMarker.length;
    const currentBlock = existingContent.slice(start, endExclusive);

    if (currentBlock === nextBlock) {
      return {
        action: "noop",
        content: existingContent,
        startMarker,
        endMarker,
      };
    }

    return {
      action: "replace",
      content: `${existingContent.slice(0, start)}${nextBlock}${existingContent.slice(endExclusive)}`,
      startMarker,
      endMarker,
    };
  }

  const separator = existingContent.trim().length > 0 ? "\n\n" : "";

  return {
    action: "append",
    content: `${existingContent}${separator}${nextBlock}`,
    startMarker,
    endMarker,
  };
}
