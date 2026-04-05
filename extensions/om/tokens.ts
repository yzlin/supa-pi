import type {
  OmActiveThread,
  OmCompactionPayloadInput,
  OmHeaderInput,
  OmObservation,
  OmPromptTurn,
  OmReflection,
  OmStableFact,
} from "./types";

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

function renderReflectionList(reflections: OmReflection[]): string[] {
  return reflections.map(
    (reflection) => `[${reflection.id}] ${reflection.summary}`
  );
}

function renderSection(title: string, lines: string[]): string[] {
  if (lines.length === 0) {
    return [];
  }

  return [title, ...lines, ""];
}

function selectItemsWithinTokenBudget<T>(
  items: readonly T[],
  maxTokens: number | false,
  estimateTokens: (item: T) => number
): T[] {
  if (maxTokens === false) {
    return [...items];
  }

  if (maxTokens <= 0) {
    return [];
  }

  let remainingTokens = Math.trunc(maxTokens);
  const selected: T[] = [];

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const itemTokens = estimateTokens(item);
    if (itemTokens > remainingTokens) {
      continue;
    }

    remainingTokens -= itemTokens;
    selected.push(item);
  }

  return selected.reverse();
}

export function estimateOmTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateOmTurnTokens(turn: OmPromptTurn): number {
  return estimateOmTextTokens(`[${turn.id}] ${turn.role}: ${turn.text}`);
}

export function estimateOmObservationTokens(
  observation: OmObservation
): number {
  return estimateOmTextTokens(
    `[${observation.id}] (${observation.kind}) ${observation.summary}`
  );
}

export function estimateOmReflectionTokens(reflection: OmReflection): number {
  return estimateOmTextTokens(`[${reflection.id}] ${reflection.summary}`);
}

export function estimateOmHeaderTokens(input: OmHeaderInput): number {
  const facts = input.stableFacts.slice(0, input.configSnapshot.headerMaxFacts);
  const threads = input.activeThreads.slice(
    0,
    input.configSnapshot.headerMaxThreads
  );

  if (facts.length === 0 && threads.length === 0) {
    return 0;
  }

  const lines = ["[Observational Memory]"];

  if (facts.length > 0) {
    lines.push("Stable facts:", ...renderFactList(facts));
  }

  if (threads.length > 0) {
    lines.push("Active threads:", ...renderThreadList(threads));
  }

  return estimateOmTextTokens(lines.join("\n"));
}

export function estimateOmCompactionPayloadTokens(
  input: OmCompactionPayloadInput
): number {
  const facts = renderFactList(input.stableFacts);
  const threads = renderThreadList(input.activeThreads);
  const reflections = renderReflectionList(
    input.reflections.slice(0, input.configSnapshot.compactionMaxReflections)
  );
  const observations = input.observations
    .slice(0, input.configSnapshot.compactionMaxObservations)
    .map((observation) => `- (${observation.kind}) ${observation.summary}`);

  const sections = [
    ...renderSection("### Stable Facts", facts),
    ...renderSection("### Active Threads", threads),
    ...renderSection("### Reflections", reflections),
    ...renderSection("### Recent Observations", observations),
  ];

  if (sections.length === 0) {
    return 0;
  }

  return estimateOmTextTokens(
    ["## Observational Memory", "", ...sections].join("\n").trimEnd()
  );
}

export function selectTurnsWithinTokenBudget(
  turns: readonly OmPromptTurn[],
  maxTokens: number | false
): OmPromptTurn[] {
  return selectItemsWithinTokenBudget(turns, maxTokens, estimateOmTurnTokens);
}

export function selectObservationsWithinTokenBudget(
  observations: readonly OmObservation[],
  maxTokens: number | false
): OmObservation[] {
  return selectItemsWithinTokenBudget(
    observations,
    maxTokens,
    estimateOmObservationTokens
  );
}

export function selectReflectionsWithinTokenBudget(
  reflections: readonly OmReflection[],
  maxTokens: number | false
): OmReflection[] {
  return selectItemsWithinTokenBudget(
    reflections,
    maxTokens,
    estimateOmReflectionTokens
  );
}
