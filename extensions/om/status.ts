import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";

import { diffOmBranchEntriesSince } from "./branch";
import { resolveOmBufferTokens } from "./buffer";
import { createOmObserverWindow, serializeOmObserverEntry } from "./observer";
import { createOmReflectorWindow } from "./reflector";
import type { OmRestorePlan } from "./restore";
import { estimateOmObservationTokens, estimateOmTurnTokens } from "./tokens";
import type {
  OmObservationBufferEnvelopeV1,
  OmPromptTurn,
  OmRecentEvent,
  OmReflectionBufferEnvelopeV1,
  OmStateV1,
} from "./types";
import {
  OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
  OM_REFLECTION_BUFFER_CUSTOM_TYPE,
  OM_STATE_CUSTOM_TYPE,
} from "./version";

const OVERLAY_MIN_WIDTH = 76;
const OVERLAY_MAX_WIDTH = 96;
const TEXT_FALLBACK_WIDTH = 56;
const BAR_WIDTH = 74;
const HELP = "enter/esc/q close";

type ThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

interface OmStatusEntryLike {
  id: string;
  type?: string;
  customType?: string;
  message?: unknown;
}

export interface OmStatusSnapshot {
  counts: {
    stableFacts: number;
    activeThreads: number;
    observations: number;
    reflections: number;
  };
  continuation?: {
    currentTask?: string;
    suggestedNextResponse?: string;
  };
  recentEvents: OmRecentEvent[];
  lastProcessedEntryId: string | null;
  restore: string;
  updatedAt: string;
  observer: {
    status: string;
    reason: string;
    pendingEntryCount: number;
    pendingTurnCount: number;
    pendingTokens: number;
    thresholdTokens: number;
    blockAfterTokens: number;
    bufferTokens: number;
    bufferThresholdTokens: number | false;
    bufferStatus: string;
    bufferSourceCount: number;
  };
  reflector: {
    status: string;
    reason: string;
    retainedObservationCount: number;
    retainedObservationTokens: number;
    thresholdTokens: number;
    blockAfterTokens: number;
    observationsToReflectCount: number;
    bufferTokens: number;
    bufferThresholdTokens: number;
    bufferStatus: string;
    bufferSourceCount: number;
  };
}

function formatCount(value: number | false | null): string {
  if (value === false) {
    return "disabled";
  }

  if (value === null) {
    return "none";
  }

  return value.toLocaleString("en-US");
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatRecentEventTime(createdAt: string): string {
  const [date = "", time = ""] = createdAt.split("T");
  const shortTime = time.slice(0, 8);
  return shortTime ? `${date} ${shortTime}` : createdAt;
}

function ratioToPercent(current: number, threshold: number | false): number {
  if (threshold === false || threshold <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, (current / threshold) * 100));
}

function repeat(char: string, count: number): string {
  return char.repeat(Math.max(0, count));
}

function renderProgressBar(
  percent: number,
  width = BAR_WIDTH,
  theme?: ThemeLike
): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const filledText = repeat("█", filled);
  const emptyText = repeat("░", width - filled);

  if (!theme) {
    return `${filledText}${emptyText}`;
  }

  return `${theme.fg(progressTone(percent), filledText)}${theme.fg("dim", emptyText)}`;
}

function progressTone(percent: number): string {
  if (percent >= 100) {
    return "error";
  }

  if (percent >= 80) {
    return "warning";
  }

  if (percent >= 50) {
    return "accent";
  }

  return "success";
}

function border(
  width: number,
  left: string,
  fill: string,
  right: string
): string {
  return `${left}${fill.repeat(Math.max(0, width - 2))}${right}`;
}

function frameLine(content: string, width: number): string {
  const innerWidth = Math.max(0, width - 4);
  const clipped = truncateToWidth(content, innerWidth);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  return `│ ${clipped}${padding} │`;
}

function centerText(content: string, width: number): string {
  const clipped = truncateToWidth(content, width);
  const remaining = Math.max(0, width - visibleWidth(clipped));
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${" ".repeat(left)}${clipped}${" ".repeat(right)}`;
}

function getStatusTone(status: string, reason: string): string {
  if (reason === "block-after") {
    return "warning";
  }

  if (status === "ready" || status === "pending" || status === "activated") {
    return "accent";
  }

  if (status === "rebuild") {
    return "warning";
  }

  if (status === "superseded") {
    return "dim";
  }

  return "muted";
}

function renderStatus(
  status: string,
  reason: string,
  theme?: ThemeLike
): string {
  const text = `${status}/${reason}`;
  return theme ? theme.fg(getStatusTone(status, reason), text) : text;
}

function isOmOwnedCustomEntry(entry: {
  type?: string;
  customType?: string;
}): boolean {
  return (
    entry.type === "custom" &&
    [
      OM_STATE_CUSTOM_TYPE,
      OM_OBSERVATION_BUFFER_CUSTOM_TYPE,
      OM_REFLECTION_BUFFER_CUSTOM_TYPE,
    ].includes(entry.customType ?? "")
  );
}

function sumObservationTokens(state: OmStateV1): number {
  return state.observations.reduce(
    (totalTokens, observation) =>
      totalTokens + estimateOmObservationTokens(observation),
    0
  );
}

function getContinuationHints(snapshot: OmStatusSnapshot) {
  return snapshot.continuation ?? {};
}

export function createOmStatusSnapshot<
  TEntry extends OmStatusEntryLike,
>(input: {
  state: OmStateV1;
  branchEntries: readonly TEntry[];
  restorePlan: OmRestorePlan | null;
  pendingObservationBuffer: OmObservationBufferEnvelopeV1 | null;
  pendingReflectionBuffer: OmReflectionBufferEnvelopeV1 | null;
  recentEvents?: readonly OmRecentEvent[];
}): OmStatusSnapshot {
  const { state, branchEntries, restorePlan } = input;
  const delta = diffOmBranchEntriesSince(
    branchEntries,
    state.lastProcessedEntryId
  );
  const pendingEntries = delta.pendingEntries.filter(
    (entry) => !isOmOwnedCustomEntry(entry)
  );
  const pendingTurns = pendingEntries
    .map((entry) => serializeOmObserverEntry(entry))
    .filter((turn): turn is OmPromptTurn => Boolean(turn));
  const pendingTokens = pendingTurns.reduce(
    (totalTokens, turn) => totalTokens + estimateOmTurnTokens(turn),
    0
  );
  const observerThreshold = state.configSnapshot.observation.messageTokens;
  const observerWindow = createOmObserverWindow(
    branchEntries,
    state.lastProcessedEntryId,
    {
      maxTurns: state.configSnapshot.observerMaxTurns,
      observationMessageTokens: observerThreshold,
      blockAfter: state.configSnapshot.observation.blockAfter,
    }
  );
  const observerBlockAfter = Math.ceil(
    observerThreshold * state.configSnapshot.observation.blockAfter
  );
  const observationBufferThreshold = resolveOmBufferTokens(
    state.configSnapshot.observation.bufferTokens,
    observerThreshold
  );

  const reflectorWindow = createOmReflectorWindow(state);
  const retainedObservationTokens = sumObservationTokens(state);
  const reflectionThreshold = state.configSnapshot.reflection.observationTokens;
  const reflectionBlockAfter = Math.ceil(
    reflectionThreshold * state.configSnapshot.reflection.blockAfter
  );
  const reflectionBufferThreshold = Math.max(
    1,
    Math.ceil(
      reflectionThreshold * state.configSnapshot.reflection.bufferActivation
    )
  );

  return {
    counts: {
      stableFacts: state.stableFacts.length,
      activeThreads: state.activeThreads.length,
      observations: state.observations.length,
      reflections: state.reflections.length,
    },
    continuation: {
      ...(state.currentTask ? { currentTask: state.currentTask } : {}),
      ...(state.suggestedNextResponse
        ? { suggestedNextResponse: state.suggestedNextResponse }
        : {}),
    },
    recentEvents: input.recentEvents ? [...input.recentEvents] : [],
    lastProcessedEntryId: state.lastProcessedEntryId,
    restore: restorePlan ? `${restorePlan.mode}/${restorePlan.reason}` : "none",
    updatedAt: state.updatedAt,
    observer: {
      status: observerWindow.status,
      reason: observerWindow.reason,
      pendingEntryCount: pendingEntries.length,
      pendingTurnCount: pendingTurns.length,
      pendingTokens,
      thresholdTokens: observerThreshold,
      blockAfterTokens: observerBlockAfter,
      bufferTokens: input.pendingObservationBuffer?.buffer.messageTokens ?? 0,
      bufferThresholdTokens: observationBufferThreshold,
      bufferStatus: input.pendingObservationBuffer?.buffer.status ?? "none",
      bufferSourceCount:
        input.pendingObservationBuffer?.buffer.sourceEntryIds.length ?? 0,
    },
    reflector: {
      status: reflectorWindow.status,
      reason: reflectorWindow.reason,
      retainedObservationCount: state.observations.length,
      retainedObservationTokens,
      thresholdTokens: reflectionThreshold,
      blockAfterTokens: reflectionBlockAfter,
      observationsToReflectCount: reflectorWindow.observationsToReflect.length,
      bufferTokens:
        input.pendingReflectionBuffer?.buffer.observationTokens ?? 0,
      bufferThresholdTokens: reflectionBufferThreshold,
      bufferStatus: input.pendingReflectionBuffer?.buffer.status ?? "none",
      bufferSourceCount:
        input.pendingReflectionBuffer?.buffer.sourceObservationIds.length ?? 0,
    },
  };
}

export function formatOmStatusSummary(snapshot: OmStatusSnapshot): string {
  const continuation = getContinuationHints(snapshot);
  const lastEvent = snapshot.recentEvents.at(-1)?.message;
  const failureSummary = summarizeRecentFailures(snapshot.recentEvents)
    .map(({ label, count }) => `${label}×${count}`)
    .join(", ");

  return [
    `facts=${snapshot.counts.stableFacts}`,
    `threads=${snapshot.counts.activeThreads}`,
    `observations=${snapshot.counts.observations}`,
    `reflections=${snapshot.counts.reflections}`,
    `events=${snapshot.recentEvents.length}`,
    continuation.currentTask ? `currentTask=${continuation.currentTask}` : null,
    continuation.suggestedNextResponse
      ? `nextResponse=${continuation.suggestedNextResponse}`
      : null,
    `lastProcessed=${snapshot.lastProcessedEntryId ?? "none"}`,
    `restore=${snapshot.restore}`,
    `obs=${formatCount(snapshot.observer.pendingTokens)}/${formatCount(snapshot.observer.thresholdTokens)} ${snapshot.observer.status}/${snapshot.observer.reason}`,
    `obsBuffer=${formatCount(snapshot.observer.bufferTokens)}/${formatCount(snapshot.observer.bufferThresholdTokens)} ${snapshot.observer.bufferStatus}`,
    `refl=${formatCount(snapshot.reflector.retainedObservationTokens)}/${formatCount(snapshot.reflector.thresholdTokens)} ${snapshot.reflector.status}/${snapshot.reflector.reason}`,
    `reflBuffer=${formatCount(snapshot.reflector.bufferTokens)}/${formatCount(snapshot.reflector.bufferThresholdTokens)} ${snapshot.reflector.bufferStatus}`,
    failureSummary ? `failures=${failureSummary}` : null,
    lastEvent ? `lastEvent=${lastEvent}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" | ");
}

function renderMetricLine(input: {
  label: string;
  current: number;
  threshold: number | false;
  theme: ThemeLike;
}): string {
  const percent = ratioToPercent(input.current, input.threshold);
  return `${input.label} ${formatCount(input.current)} / ${formatCount(input.threshold)} tokens (${input.theme.fg(progressTone(percent), formatPercent(percent))})`;
}

function renderDetailLine(input: {
  left: string;
  right: string;
  theme: ThemeLike;
}): string {
  return `${input.left} ${input.theme.fg("dim", "·")} ${input.right}`;
}

function getRecentEventTone(event: OmRecentEvent): string {
  if (event.level === "error") {
    return "error";
  }

  if (event.level === "warning") {
    return "warning";
  }

  if (event.level === "success") {
    return "success";
  }

  return "accent";
}

function renderRecentEventLine(event: OmRecentEvent, theme: ThemeLike): string {
  const tone = getRecentEventTone(event);

  return `${theme.fg("muted", formatRecentEventTime(event.createdAt))} ${theme.fg(tone, event.message)}`;
}

function wrapPlainText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || text.length === 0) {
    return [text];
  }

  const lines: string[] = [];
  let remaining = text;

  while (visibleWidth(remaining) > maxWidth) {
    const segment = truncateToWidth(remaining, maxWidth);

    if (!segment) {
      break;
    }

    lines.push(segment);
    remaining = remaining.slice(segment.length);
  }

  if (remaining.length > 0 || lines.length === 0) {
    lines.push(remaining);
  }

  return lines;
}

function renderRecentEventLines(
  event: OmRecentEvent,
  theme: ThemeLike,
  width: number
): string[] {
  const previewMarker = " preview=";
  const previewMarkerIndex = event.message.indexOf(previewMarker);
  const closingBracketIndex = event.message.lastIndexOf("]");

  if (previewMarkerIndex === -1 || closingBracketIndex === -1) {
    return [frameLine(renderRecentEventLine(event, theme), width)];
  }

  const messagePrefix = event.message.slice(0, previewMarkerIndex);
  const previewText = event.message.slice(
    previewMarkerIndex + previewMarker.length,
    closingBracketIndex
  );
  const messageSuffix = event.message.slice(closingBracketIndex);
  const tone = getRecentEventTone(event);
  const timestampPrefix = `${formatRecentEventTime(event.createdAt)} `;
  const detailPrefix = "  ";
  const previewWidth = Math.max(8, width - 4 - detailPrefix.length);

  return [
    frameLine(
      `${theme.fg("muted", timestampPrefix)}${theme.fg(tone, messagePrefix)}`,
      width
    ),
    frameLine(`${detailPrefix}${theme.fg(tone, "preview=")}`, width),
    ...wrapPlainText(previewText, previewWidth).map((line) =>
      frameLine(`${detailPrefix}${theme.fg(tone, line)}`, width)
    ),
    frameLine(`${detailPrefix}${theme.fg(tone, messageSuffix)}`, width),
  ];
}

const OM_RECENT_FAILURE_MATCHERS = [
  ["no observer model available", "missing-model"],
  ["model auth unavailable", "auth-failed"],
  ["provider returned an error", "provider-error"],
  ["returned invalid JSON", "invalid-json"],
  ["returned empty output", "empty-output"],
  ["aborted while processing", "aborted"],
  ["failed while processing", "completion-error"],
] as const satisfies ReadonlyArray<readonly [string, string]>;

function classifyRecentFailure(event: OmRecentEvent): string | null {
  for (const [needle, label] of OM_RECENT_FAILURE_MATCHERS) {
    if (event.message.includes(needle)) {
      return label;
    }
  }

  return null;
}

function summarizeRecentFailures(
  recentEvents: readonly OmRecentEvent[]
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();

  for (const event of recentEvents) {
    const label = classifyRecentFailure(event);

    if (label) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.label.localeCompare(right.label)
    );
}

export async function showOmStatusView(
  ctx: ExtensionCommandContext,
  snapshot: OmStatusSnapshot
): Promise<void> {
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
    ctx.ui.notify(formatOmStatusSummary(snapshot), "info");
    return;
  }

  await ctx.ui.custom<void>(
    (_tui, theme, _kb, done) => ({
      invalidate() {},
      render(width: number) {
        if (width < TEXT_FALLBACK_WIDTH) {
          return [truncateToWidth(formatOmStatusSummary(snapshot), width)];
        }

        const continuation = getContinuationHints(snapshot);
        const frameWidth = width;
        const innerWidth = Math.max(8, frameWidth - 4);
        const barWidth = Math.max(12, Math.min(BAR_WIDTH, innerWidth));
        const observerPercent = ratioToPercent(
          snapshot.observer.pendingTokens,
          snapshot.observer.thresholdTokens
        );
        const observerBufferPercent = ratioToPercent(
          snapshot.observer.bufferTokens,
          snapshot.observer.bufferThresholdTokens
        );
        const reflectorPercent = ratioToPercent(
          snapshot.reflector.retainedObservationTokens,
          snapshot.reflector.thresholdTokens
        );
        const reflectorBufferPercent = ratioToPercent(
          snapshot.reflector.bufferTokens,
          snapshot.reflector.bufferThresholdTokens
        );
        const recentFailures = summarizeRecentFailures(snapshot.recentEvents);

        return [
          border(frameWidth, "╭", "─", "╮"),
          frameLine(
            centerText(
              theme.bold(theme.fg("accent", "Observational Memory Status")),
              innerWidth
            ),
            frameWidth
          ),
          frameLine(
            centerText(
              theme.fg(
                "dim",
                `restore ${snapshot.restore} · updated ${snapshot.updatedAt}`
              ),
              innerWidth
            ),
            frameWidth
          ),
          border(frameWidth, "├", "─", "┤"),
          frameLine(theme.bold(theme.fg("toolTitle", "Overview")), frameWidth),
          frameLine(
            `${theme.fg("accent", "■")} facts ${formatCount(snapshot.counts.stableFacts)}  ${theme.fg("accent", "■")} threads ${formatCount(snapshot.counts.activeThreads)}  ${theme.fg("accent", "■")} observations ${formatCount(snapshot.counts.observations)}  ${theme.fg("accent", "■")} reflections ${formatCount(snapshot.counts.reflections)}`,
            frameWidth
          ),
          frameLine(
            `${theme.fg("muted", "last processed")} ${snapshot.lastProcessedEntryId ?? "none"}`,
            frameWidth
          ),
          ...(continuation.currentTask || continuation.suggestedNextResponse
            ? [
                border(frameWidth, "├", "─", "┤"),
                frameLine(
                  theme.bold(theme.fg("toolTitle", "Continuation")),
                  frameWidth
                ),
                ...(continuation.currentTask
                  ? [
                      frameLine(
                        `${theme.fg("muted", "Current task")} ${continuation.currentTask}`,
                        frameWidth
                      ),
                    ]
                  : []),
                ...(continuation.suggestedNextResponse
                  ? [
                      frameLine(
                        `${theme.fg("muted", "Suggested next response")} ${continuation.suggestedNextResponse}`,
                        frameWidth
                      ),
                    ]
                  : []),
              ]
            : []),
          border(frameWidth, "├", "─", "┤"),
          frameLine(
            theme.bold(theme.fg("toolTitle", "Observer pipeline")),
            frameWidth
          ),
          frameLine(
            renderMetricLine({
              label: "Pending raw turns",
              current: snapshot.observer.pendingTokens,
              threshold: snapshot.observer.thresholdTokens,
              theme,
            }),
            frameWidth
          ),
          frameLine(
            renderProgressBar(observerPercent, barWidth, theme),
            frameWidth
          ),
          frameLine(
            renderDetailLine({
              left: `${theme.fg("muted", "window")} ${renderStatus(snapshot.observer.status, snapshot.observer.reason, theme)}`,
              right: `${theme.fg("muted", "entries/turns/block")} ${formatCount(snapshot.observer.pendingEntryCount)}/${formatCount(snapshot.observer.pendingTurnCount)}/${formatCount(snapshot.observer.blockAfterTokens)}`,
              theme,
            }),
            frameWidth
          ),
          frameLine(
            renderMetricLine({
              label: "Buffered observation",
              current: snapshot.observer.bufferTokens,
              threshold: snapshot.observer.bufferThresholdTokens,
              theme,
            }),
            frameWidth
          ),
          frameLine(
            renderProgressBar(observerBufferPercent, barWidth, theme),
            frameWidth
          ),
          frameLine(
            renderDetailLine({
              left: `${theme.fg("muted", "buffer")} ${theme.fg(getStatusTone(snapshot.observer.bufferStatus, snapshot.observer.bufferStatus), snapshot.observer.bufferStatus)}`,
              right: `${theme.fg("muted", "source entries")} ${formatCount(snapshot.observer.bufferSourceCount)}`,
              theme,
            }),
            frameWidth
          ),
          border(frameWidth, "├", "─", "┤"),
          frameLine(
            theme.bold(theme.fg("toolTitle", "Reflector pipeline")),
            frameWidth
          ),
          frameLine(
            renderMetricLine({
              label: "Retained observations",
              current: snapshot.reflector.retainedObservationTokens,
              threshold: snapshot.reflector.thresholdTokens,
              theme,
            }),
            frameWidth
          ),
          frameLine(
            renderProgressBar(reflectorPercent, barWidth, theme),
            frameWidth
          ),
          frameLine(
            renderDetailLine({
              left: `${theme.fg("muted", "window")} ${renderStatus(snapshot.reflector.status, snapshot.reflector.reason, theme)}`,
              right: `${theme.fg("muted", "observations/block")} ${formatCount(snapshot.reflector.retainedObservationCount)}/${formatCount(snapshot.reflector.blockAfterTokens)}`,
              theme,
            }),
            frameWidth
          ),
          frameLine(
            renderMetricLine({
              label: "Buffered reflection",
              current: snapshot.reflector.bufferTokens,
              threshold: snapshot.reflector.bufferThresholdTokens,
              theme,
            }),
            frameWidth
          ),
          frameLine(
            renderProgressBar(reflectorBufferPercent, barWidth, theme),
            frameWidth
          ),
          frameLine(
            renderDetailLine({
              left: `${theme.fg("muted", "buffer")} ${theme.fg(getStatusTone(snapshot.reflector.bufferStatus, snapshot.reflector.bufferStatus), snapshot.reflector.bufferStatus)}`,
              right: `${theme.fg("muted", "to reflect/source")} ${formatCount(snapshot.reflector.observationsToReflectCount)}/${formatCount(snapshot.reflector.bufferSourceCount)}`,
              theme,
            }),
            frameWidth
          ),
          ...(recentFailures.length > 0
            ? [
                border(frameWidth, "├", "─", "┤"),
                frameLine(
                  theme.bold(theme.fg("toolTitle", "Recent failures")),
                  frameWidth
                ),
                ...recentFailures.map(({ label, count }) =>
                  frameLine(
                    `${theme.fg("warning", label)} ${theme.fg("dim", "×")} ${formatCount(count)}`,
                    frameWidth
                  )
                ),
              ]
            : []),
          border(frameWidth, "├", "─", "┤"),
          frameLine(
            theme.bold(theme.fg("toolTitle", "Recent activity")),
            frameWidth
          ),
          ...(snapshot.recentEvents.length > 0
            ? [...snapshot.recentEvents]
                .slice(-5)
                .reverse()
                .flatMap((event) =>
                  renderRecentEventLines(event, theme, frameWidth)
                )
            : [
                frameLine(
                  theme.fg("dim", "No recent OM activity in this session."),
                  frameWidth
                ),
              ]),
          border(frameWidth, "├", "─", "┤"),
          frameLine(centerText(theme.fg("dim", HELP), innerWidth), frameWidth),
          border(frameWidth, "╰", "─", "╯"),
        ];
      },
      handleInput(data: string) {
        if (
          matchesKey(data, Key.enter) ||
          matchesKey(data, Key.escape) ||
          data.toLowerCase() === "q"
        ) {
          done(undefined);
        }
      },
    }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "78%",
        minWidth: OVERLAY_MIN_WIDTH,
        maxWidth: OVERLAY_MAX_WIDTH,
        margin: 1,
      },
    }
  );
}
