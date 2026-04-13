import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
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
const LIST_VISIBLE_ITEMS = 6;
const DETAIL_VISIBLE_LINES = 10;
const OVERVIEW_HELP = "←→/tab tabs · enter/esc/q close";
const ENTITY_HELP =
  "←→/tab tabs · ↑↓/j/k item · pgup/pgdn detail · home/end · enter/esc/q close";

const PLAIN_THEME: ThemeLike = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

type ThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type OmStatusEntityTabKey =
  | "facts"
  | "threads"
  | "observations"
  | "reflections";

type OmStatusTabKey = "overview" | OmStatusEntityTabKey;

interface OmStatusTabDefinition {
  key: OmStatusTabKey;
  label: string;
}

interface OmStatusEntityItem {
  id: string;
  listLabel: string;
  meta: string[];
  sections: Array<{
    label: string;
    lines: string[];
  }>;
}

const OM_STATUS_TABS: readonly OmStatusTabDefinition[] = [
  { key: "overview", label: "Overview" },
  { key: "facts", label: "Facts" },
  { key: "threads", label: "Threads" },
  { key: "observations", label: "Observations" },
  { key: "reflections", label: "Reflections" },
] as const;

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
  entities: {
    stableFacts: OmStateV1["stableFacts"];
    activeThreads: OmStateV1["activeThreads"];
    observations: OmStateV1["observations"];
    reflections: OmStateV1["reflections"];
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

function styleFrameLine(line: string, theme: ThemeLike): string {
  if (/^[╭╮╰╯├┤─]+$/u.test(line)) {
    return theme.fg("dim", line);
  }

  if (!line.startsWith("│ ") || !line.endsWith(" │")) {
    return line;
  }

  const content = line.slice(1, -1);
  return `${theme.fg("dim", "│")}${content}${theme.fg("dim", "│")}`;
}

function centerText(content: string, width: number): string {
  const clipped = truncateToWidth(content, width);
  const remaining = Math.max(0, width - visibleWidth(clipped));
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${" ".repeat(left)}${clipped}${" ".repeat(right)}`;
}

function wrapRenderableText(text: string, width: number): string[] {
  if (!text) {
    return [""];
  }

  return text.split("\n").flatMap((line) => {
    if (!line) {
      return [""];
    }

    return wrapTextWithAnsi(line, width).map((item) =>
      truncateToWidth(item, width)
    );
  });
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

function getTabLabel(snapshot: OmStatusSnapshot, key: OmStatusTabKey): string {
  switch (key) {
    case "facts":
      return `Facts (${snapshot.entities.stableFacts.length})`;
    case "threads":
      return `Threads (${snapshot.entities.activeThreads.length})`;
    case "observations":
      return `Observations (${snapshot.entities.observations.length})`;
    case "reflections":
      return `Reflections (${snapshot.entities.reflections.length})`;
    default:
      return "Overview";
  }
}

function renderTabBar(
  snapshot: OmStatusSnapshot,
  activeTab: OmStatusTabKey,
  theme: ThemeLike,
  width: number
): string {
  const separator = theme.fg("dim", " · ");
  const text = OM_STATUS_TABS.map((tab) => {
    const label = getTabLabel(snapshot, tab.key);
    return tab.key === activeTab
      ? theme.bold(theme.fg("accent", `[${label}]`))
      : theme.fg("muted", label);
  }).join(separator);

  return truncateToWidth(text, width);
}

function clampIndex(value: number, itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(itemCount - 1, value));
}

function matchesInputKey(data: string, key: string): boolean {
  return data === key || matchesKey(data, key);
}

function listOrNone(values: readonly string[]): string[] {
  return values.length > 0 ? [...values] : ["none"];
}

function buildEntityItems(
  snapshot: OmStatusSnapshot,
  tabKey: OmStatusEntityTabKey
): OmStatusEntityItem[] {
  switch (tabKey) {
    case "facts":
      return snapshot.entities.stableFacts.map((fact) => ({
        id: fact.id,
        listLabel: `${fact.id} ${fact.text}`,
        meta: [
          `updated ${fact.updatedAt}`,
          `sources ${formatCount(fact.sourceEntryIds.length)}`,
        ],
        sections: [
          { label: "Text", lines: [fact.text] },
          {
            label: "Source entries",
            lines: listOrNone(fact.sourceEntryIds),
          },
        ],
      }));
    case "threads":
      return snapshot.entities.activeThreads.map((thread) => ({
        id: thread.id,
        listLabel: `${thread.id} [${thread.status}] ${thread.title}`,
        meta: [
          `status ${thread.status}`,
          `updated ${thread.updatedAt}`,
          `sources ${formatCount(thread.sourceEntryIds.length)}`,
        ],
        sections: [
          { label: "Title", lines: [thread.title] },
          {
            label: "Summary",
            lines: [thread.summary ?? "No summary recorded."],
          },
          {
            label: "Source entries",
            lines: listOrNone(thread.sourceEntryIds),
          },
        ],
      }));
    case "observations":
      return snapshot.entities.observations.map((observation) => ({
        id: observation.id,
        listLabel: `${observation.id} [${observation.kind}] ${observation.summary}`,
        meta: [
          `kind ${observation.kind}`,
          `created ${observation.createdAt}`,
          `sources ${formatCount(observation.sourceEntryIds.length)}`,
        ],
        sections: [
          { label: "Summary", lines: [observation.summary] },
          {
            label: "Source entries",
            lines: listOrNone(observation.sourceEntryIds),
          },
        ],
      }));
    case "reflections":
      return snapshot.entities.reflections.map((reflection) => ({
        id: reflection.id,
        listLabel: `${reflection.id} ${reflection.summary}`,
        meta: [
          `created ${reflection.createdAt}`,
          `source observations ${formatCount(reflection.sourceObservationIds.length)}`,
        ],
        sections: [
          { label: "Summary", lines: [reflection.summary] },
          {
            label: "Source observations",
            lines: listOrNone(reflection.sourceObservationIds),
          },
        ],
      }));
  }
}

function buildEntityDetailLines(
  item: OmStatusEntityItem,
  width: number,
  theme: ThemeLike
): string[] {
  const lines = [theme.bold(item.id)];

  if (item.meta.length > 0) {
    lines.push(theme.fg("muted", item.meta.join(" · ")));
  }

  for (const section of item.sections) {
    lines.push("");
    lines.push(theme.bold(section.label));

    const sectionLines = section.lines.length > 0 ? section.lines : ["none"];
    for (const sectionLine of sectionLines) {
      lines.push(...wrapRenderableText(`  ${sectionLine}`, width));
    }
  }

  return lines;
}

function getEntityDetailLineCount(
  snapshot: OmStatusSnapshot,
  tabKey: OmStatusEntityTabKey,
  selectedIndex: number,
  width: number
): number {
  const items = buildEntityItems(snapshot, tabKey);
  if (items.length === 0) {
    return 1;
  }

  return buildEntityDetailLines(
    items[clampIndex(selectedIndex, items.length)],
    Math.max(8, width),
    PLAIN_THEME
  ).length;
}

function renderOverviewLines(
  snapshot: OmStatusSnapshot,
  theme: ThemeLike,
  frameWidth: number,
  innerWidth: number
): string[] {
  const continuation = getContinuationHints(snapshot);
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
    frameLine(renderProgressBar(observerPercent, barWidth, theme), frameWidth),
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
    frameLine(renderProgressBar(reflectorPercent, barWidth, theme), frameWidth),
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
    frameLine(theme.bold(theme.fg("toolTitle", "Recent activity")), frameWidth),
    ...(snapshot.recentEvents.length > 0
      ? [...snapshot.recentEvents]
          .slice(-5)
          .reverse()
          .flatMap((event) => renderRecentEventLines(event, theme, frameWidth))
      : [
          frameLine(
            theme.fg("dim", "No recent OM activity in this session."),
            frameWidth
          ),
        ]),
  ];
}

function renderEntityLines(
  snapshot: OmStatusSnapshot,
  tabKey: OmStatusEntityTabKey,
  selectedIndex: number,
  detailScroll: number,
  theme: ThemeLike,
  frameWidth: number,
  innerWidth: number
): string[] {
  const items = buildEntityItems(snapshot, tabKey);
  const tabTitle = getTabLabel(snapshot, tabKey);

  if (items.length === 0) {
    return [
      frameLine(theme.bold(theme.fg("toolTitle", tabTitle)), frameWidth),
      frameLine(
        theme.fg("dim", "No items in current branch OM state."),
        frameWidth
      ),
    ];
  }

  const clampedSelection = clampIndex(selectedIndex, items.length);
  const selectedItem = items[clampedSelection];
  const listStart = Math.max(
    0,
    Math.min(
      clampedSelection - Math.floor(LIST_VISIBLE_ITEMS / 2),
      Math.max(0, items.length - LIST_VISIBLE_ITEMS)
    )
  );
  const visibleItems = items.slice(listStart, listStart + LIST_VISIBLE_ITEMS);
  const detailLines = buildEntityDetailLines(selectedItem, innerWidth, theme);
  const maxDetailScroll = Math.max(
    0,
    detailLines.length - DETAIL_VISIBLE_LINES
  );
  const clampedDetailScroll = Math.max(
    0,
    Math.min(maxDetailScroll, detailScroll)
  );
  const visibleDetail = detailLines.slice(
    clampedDetailScroll,
    clampedDetailScroll + DETAIL_VISIBLE_LINES
  );

  return [
    frameLine(theme.bold(theme.fg("toolTitle", tabTitle)), frameWidth),
    frameLine(
      `${theme.fg("muted", "Items")} ${listStart + 1}-${Math.min(items.length, listStart + visibleItems.length)}/${items.length}`,
      frameWidth
    ),
    ...visibleItems.map((item, index) => {
      const actualIndex = listStart + index;
      const prefix =
        actualIndex === clampedSelection ? theme.fg("accent", "> ") : "  ";
      const color = actualIndex === clampedSelection ? "accent" : "text";
      return frameLine(
        `${prefix}${theme.fg(color, item.listLabel)}`,
        frameWidth
      );
    }),
    border(frameWidth, "├", "─", "┤"),
    frameLine(
      `${theme.fg("muted", "Selected")} ${selectedItem.id} ${theme.fg("dim", "·")} ${formatCount(clampedSelection + 1)}/${formatCount(items.length)} ${theme.fg("dim", "·")} ${theme.fg("muted", "detail")} ${clampedDetailScroll + 1}-${Math.min(detailLines.length, clampedDetailScroll + visibleDetail.length)}/${detailLines.length}`,
      frameWidth
    ),
    ...visibleDetail.map((line) => frameLine(line, frameWidth)),
  ];
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
    entities: {
      stableFacts: state.stableFacts.map((fact) => ({
        ...fact,
        sourceEntryIds: [...fact.sourceEntryIds],
      })),
      activeThreads: state.activeThreads.map((thread) => ({
        ...thread,
        sourceEntryIds: [...thread.sourceEntryIds],
      })),
      observations: state.observations.map((observation) => ({
        ...observation,
        sourceEntryIds: [...observation.sourceEntryIds],
      })),
      reflections: state.reflections.map((reflection) => ({
        ...reflection,
        sourceObservationIds: [...reflection.sourceObservationIds],
      })),
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
    (tui, theme, _kb, done) => {
      let activeTabIndex = 0;
      let lastInnerWidth = 80;
      const selectionByTab: Record<OmStatusEntityTabKey, number> = {
        facts: 0,
        threads: 0,
        observations: 0,
        reflections: 0,
      };
      const detailScrollByTab: Record<OmStatusEntityTabKey, number> = {
        facts: 0,
        threads: 0,
        observations: 0,
        reflections: 0,
      };

      const refresh = () => {
        tui.requestRender?.();
      };

      const getActiveTab = (): OmStatusTabKey =>
        OM_STATUS_TABS[activeTabIndex]?.key ?? "overview";

      const moveTab = (delta: number) => {
        activeTabIndex =
          (activeTabIndex + delta + OM_STATUS_TABS.length) %
          OM_STATUS_TABS.length;
      };

      return {
        invalidate() {},
        render(width: number) {
          if (width < TEXT_FALLBACK_WIDTH) {
            return [truncateToWidth(formatOmStatusSummary(snapshot), width)];
          }

          const frameWidth = width;
          const innerWidth = Math.max(8, frameWidth - 4);
          lastInnerWidth = innerWidth;
          const activeTab = getActiveTab();
          const bodyLines =
            activeTab === "overview"
              ? renderOverviewLines(snapshot, theme, frameWidth, innerWidth)
              : renderEntityLines(
                  snapshot,
                  activeTab,
                  selectionByTab[activeTab],
                  detailScrollByTab[activeTab],
                  theme,
                  frameWidth,
                  innerWidth
                );

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
            frameLine(
              renderTabBar(snapshot, activeTab, theme, innerWidth),
              frameWidth
            ),
            border(frameWidth, "├", "─", "┤"),
            ...bodyLines,
            border(frameWidth, "├", "─", "┤"),
            frameLine(
              centerText(
                theme.fg(
                  "dim",
                  activeTab === "overview" ? OVERVIEW_HELP : ENTITY_HELP
                ),
                innerWidth
              ),
              frameWidth
            ),
            border(frameWidth, "╰", "─", "╯"),
          ].map((line) => styleFrameLine(line, theme));
        },
        handleInput(data: string) {
          if (
            matchesInputKey(data, Key.enter) ||
            matchesInputKey(data, Key.escape) ||
            data.toLowerCase() === "q"
          ) {
            done(undefined);
            return;
          }

          if (
            matchesInputKey(data, Key.tab) ||
            matchesInputKey(data, Key.right) ||
            data.toLowerCase() === "l"
          ) {
            moveTab(1);
            refresh();
            return;
          }

          if (
            matchesInputKey(data, Key.shift("tab")) ||
            matchesInputKey(data, Key.left) ||
            data.toLowerCase() === "h"
          ) {
            moveTab(-1);
            refresh();
            return;
          }

          const activeTab = getActiveTab();
          if (activeTab === "overview") {
            return;
          }

          const items = buildEntityItems(snapshot, activeTab);
          const maxIndex = Math.max(0, items.length - 1);

          if (matchesInputKey(data, Key.up) || data.toLowerCase() === "k") {
            selectionByTab[activeTab] = Math.max(
              0,
              selectionByTab[activeTab] - 1
            );
            detailScrollByTab[activeTab] = 0;
            refresh();
            return;
          }

          if (matchesInputKey(data, Key.down) || data.toLowerCase() === "j") {
            selectionByTab[activeTab] = Math.min(
              maxIndex,
              selectionByTab[activeTab] + 1
            );
            detailScrollByTab[activeTab] = 0;
            refresh();
            return;
          }

          const maxDetailScroll = Math.max(
            0,
            getEntityDetailLineCount(
              snapshot,
              activeTab,
              selectionByTab[activeTab],
              lastInnerWidth
            ) - DETAIL_VISIBLE_LINES
          );

          if (
            matchesInputKey(data, Key.pageUp) ||
            matchesInputKey(data, Key.ctrl("b"))
          ) {
            detailScrollByTab[activeTab] = Math.max(
              0,
              detailScrollByTab[activeTab] -
                Math.max(1, DETAIL_VISIBLE_LINES - 2)
            );
            refresh();
            return;
          }

          if (
            matchesInputKey(data, Key.pageDown) ||
            matchesInputKey(data, Key.ctrl("f"))
          ) {
            detailScrollByTab[activeTab] = Math.min(
              maxDetailScroll,
              detailScrollByTab[activeTab] +
                Math.max(1, DETAIL_VISIBLE_LINES - 2)
            );
            refresh();
            return;
          }

          if (matchesInputKey(data, Key.home)) {
            detailScrollByTab[activeTab] = 0;
            refresh();
            return;
          }

          if (matchesInputKey(data, Key.end)) {
            detailScrollByTab[activeTab] = maxDetailScroll;
            refresh();
          }
        },
      };
    },
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
