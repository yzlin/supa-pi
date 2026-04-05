import { estimateOmTextTokens } from "./tokens";
import type {
  OmActiveThread,
  OmCompactionPayloadInput,
  OmHeaderInput,
  OmObservation,
  OmObserverPromptInput,
  OmPromptTurn,
  OmReflection,
  OmReflectorPromptInput,
  OmStableFact,
} from "./types";
import {
  OM_OBSERVATION_KINDS,
  OM_PROMPT_VERSION,
  OM_THREAD_STATUSES,
} from "./version";

function renderFactList(facts: OmStableFact[]): string[] {
  return facts.map((fact) => `- ${fact.text}`);
}

function renderThreadList(threads: OmActiveThread[]): string[] {
  return threads.map(
    (thread) =>
      `- [${thread.status}] ${thread.title}${
        thread.summary ? ` — ${thread.summary}` : ""
      }`
  );
}

function renderTurnList(turns: OmPromptTurn[]): string[] {
  return turns.map((turn) => `[${turn.id}] ${turn.role}: ${turn.text}`);
}

function renderObservationList(observations: OmObservation[]): string[] {
  return observations.map(
    (observation) =>
      `[${observation.id}] (${observation.kind}) ${observation.summary}`
  );
}

function fitsTokenBudget(lines: string[], maxTokens: number | false): boolean {
  if (maxTokens === false) {
    return true;
  }

  return estimateOmTextTokens(lines.join("\n").trimEnd()) <= maxTokens;
}

function buildTokenBoundedSections(
  baseLines: string[],
  sections: Array<{ title: string; lines: string[] }>,
  maxTokens: number | false
): string[] {
  if (maxTokens !== false && maxTokens <= 0) {
    return [];
  }

  if (!fitsTokenBudget(baseLines, maxTokens)) {
    return [];
  }

  const lines = [...baseLines];
  let addedSection = false;
  let shouldStop = false;

  for (const section of sections) {
    if (section.lines.length === 0 || shouldStop) {
      continue;
    }

    const selectedSectionLines: string[] = [];

    for (const line of section.lines) {
      const candidateLines = [
        ...lines,
        section.title,
        ...selectedSectionLines,
        line,
      ];

      if (!fitsTokenBudget(candidateLines, maxTokens)) {
        shouldStop = true;
        break;
      }

      selectedSectionLines.push(line);
    }

    if (selectedSectionLines.length === 0) {
      break;
    }

    lines.push(section.title, ...selectedSectionLines, "");
    addedSection = true;
  }

  return addedSection ? lines : [];
}

export function buildOmHeader(input: OmHeaderInput): string {
  const facts = input.stableFacts.slice(0, input.configSnapshot.headerMaxFacts);
  const threads = input.activeThreads.slice(
    0,
    input.configSnapshot.headerMaxThreads
  );

  if (facts.length === 0 && threads.length === 0) {
    return "";
  }

  return buildTokenBoundedSections(
    ["[Observational Memory]"],
    [
      { title: "Stable facts:", lines: renderFactList(facts) },
      { title: "Active threads:", lines: renderThreadList(threads) },
    ],
    input.configSnapshot.headerMaxTokens
  )
    .join("\n")
    .trimEnd();
}

export function buildOmObserverPrompt(input: OmObserverPromptInput): string {
  const header = buildOmHeader(input) || "(empty)";
  const previousObservations = renderObservationList(
    input.previousObservations
  );
  const turns = renderTurnList(
    input.newTurns.slice(-input.configSnapshot.observerMaxTurns)
  );

  return [
    "You are the observational memory observer for pi.",
    "Capture only branch-local, user-relevant memory. Do not invent facts.",
    "Return strict JSON only. No prose. No markdown fences.",
    'Output must be a single JSON object with exactly these top-level arrays: {"observations":[],"stableFacts":[],"activeThreads":[]}.',
    `observations[].kind must be one of: ${OM_OBSERVATION_KINDS.join(", ")}`,
    `activeThreads[].status must be one of: ${OM_THREAD_STATUSES.join(", ")}`,
    "Use [] when there is nothing to add. Keep sourceEntryIds branch-local to the provided new_branch_entries.",
    "",
    `<om_observer version=\"${OM_PROMPT_VERSION}\">`,
    `leafId: ${input.branchScope.leafId ?? "null"}`,
    `lastProcessedEntryId: ${input.lastProcessedEntryId ?? "null"}`,
    `branchEntryIds: ${input.branchScope.entryIds.join(", ") || "(none)"}`,
    "</om_observer>",
    "",
    "<current_om_header>",
    header,
    "</current_om_header>",
    "",
    "<previous_observations>",
    ...(previousObservations.length > 0 ? previousObservations : ["(none)"]),
    "</previous_observations>",
    "",
    "<new_branch_entries>",
    ...(turns.length > 0 ? turns : ["(none)"]),
    "</new_branch_entries>",
  ].join("\n");
}

function renderReflectionList(reflections: OmReflection[]): string[] {
  return reflections.map(
    (reflection) => `[${reflection.id}] ${reflection.summary}`
  );
}

export function buildOmReflectorPrompt(input: OmReflectorPromptInput): string {
  const header = buildOmHeader(input) || "(empty)";
  const observationLines = renderObservationList(input.observations);

  return [
    "You are the observational memory reflector for pi.",
    "Compress older observations into durable memory without losing active work.",
    "",
    `<om_reflector version=\"${OM_PROMPT_VERSION}\">`,
    `reflectionMinObservationCount: ${input.configSnapshot.reflectionMinObservationCount}`,
    "</om_reflector>",
    "",
    "<current_om_header>",
    header,
    "</current_om_header>",
    "",
    "<current_reflections>",
    ...(input.reflections.length > 0
      ? renderReflectionList(input.reflections)
      : ["(none)"]),
    "</current_reflections>",
    "",
    "<observations>",
    ...(observationLines.length > 0 ? observationLines : ["(none)"]),
    "</observations>",
  ].join("\n");
}

export function buildOmCompactionPayload(
  input: OmCompactionPayloadInput
): string {
  const facts = renderFactList(input.stableFacts);
  const threads = renderThreadList(input.activeThreads);
  const reflections = renderReflectionList(
    input.reflections.slice(0, input.configSnapshot.compactionMaxReflections)
  );
  const observations = input.observations
    .slice(0, input.configSnapshot.compactionMaxObservations)
    .map((observation) => `- (${observation.kind}) ${observation.summary}`);

  const lines = buildTokenBoundedSections(
    ["## Observational Memory", ""],
    [
      { title: "### Stable Facts", lines: facts },
      { title: "### Active Threads", lines: threads },
      { title: "### Reflections", lines: reflections },
      { title: "### Recent Observations", lines: observations },
    ],
    input.configSnapshot.compactionMaxTokens
  );

  if (lines.length === 0) {
    return "";
  }

  return lines.join("\n").trimEnd();
}
