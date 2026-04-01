import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { buildMapTask, runLlmTask } from "../../../pi-lcm/src/map-runner.ts";

import {
  FILE_BACKED_PLAN_EXTENSIONS,
  PLAN_REFERENCE_PREFIX,
  READ_ONLY_CONCURRENCY,
  RISKY_STEP_PATTERN,
  TASK_TEMPLATE,
  WRITE_HEAVY_CONCURRENCY,
} from "./constants";
import type { ExecutePlanDigestInput, ExecuteStepResult } from "./types";
import { uniqueStrings } from "./utils";

const normalizePlanLine = (line: string): string =>
  line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/, "").trim();

const isMarkdownPlanListLine = (line: string): boolean =>
  /^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/.test(line);

const isLikelyPlanFilePath = (input: string): boolean => {
  if (!input || /\r|\n/.test(input)) {
    return false;
  }

  const normalized = input.trim();
  if (!normalized || normalized.includes(";")) {
    return false;
  }

  return FILE_BACKED_PLAN_EXTENSIONS.has(
    path.extname(normalized).toLowerCase()
  );
};

const EMBEDDED_PLAN_REFERENCE_PATTERN =
  /(?:^|\s)@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s]+))/;

const normalizeExecutePlanItems = (items: string[]): string[] =>
  uniqueStrings(
    items
      .flatMap((item) => parsePlanItems(item))
      .map((item) => item.trim())
      .filter(Boolean)
  );

const extractEmbeddedPlanReference = (
  input: string
): { reference: string; remainingArgs: string } | null => {
  const match = input.match(EMBEDDED_PLAN_REFERENCE_PATTERN);
  if (!match || match.index == null) {
    return null;
  }

  const reference = match[1] ?? match[2] ?? match[3];
  if (!reference) {
    return null;
  }

  const before = input.slice(0, match.index).trim();
  const after = input.slice(match.index + match[0].length).trim();
  return {
    reference: reference.trim(),
    remainingArgs: [before, after].filter(Boolean).join(" ").trim(),
  };
};

const looksLikeEmbeddedPlanReference = (reference: string): boolean =>
  isLikelyPlanFilePath(reference) || /[\\/]/.test(reference);

export const parsePlanItems = (input: string): string[] => {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const lineItems = trimmed
    .split(/\r?\n/)
    .map((line) => normalizePlanLine(line))
    .filter(Boolean);

  if (lineItems.length > 1) {
    return lineItems;
  }

  const singleItem = normalizePlanLine(trimmed);
  if (!singleItem) return [];

  if (singleItem.includes(";")) {
    return singleItem
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [singleItem];
};

export const parsePlanDocumentItems = (input: string): string[] => {
  const listItems = input
    .split(/\r?\n/)
    .filter((line) => isMarkdownPlanListLine(line))
    .map((line) => normalizePlanLine(line))
    .filter(Boolean);

  if (listItems.length > 0) {
    return listItems;
  }

  return parsePlanItems(input);
};

const resolveExecutePlanReference = (
  reference: string,
  cwd: string,
  explicitReference: boolean,
  remainingArgs = ""
): {
  filePath: string;
  displayPath: string;
  explicitReference: boolean;
  remainingArgs: string;
} => ({
  filePath: path.isAbsolute(reference)
    ? reference
    : path.resolve(cwd, reference),
  displayPath: reference,
  explicitReference,
  remainingArgs,
});

const resolveExecutePlanPath = (
  input: string,
  cwd: string
): {
  filePath: string;
  displayPath: string;
  explicitReference: boolean;
  remainingArgs: string;
} | null => {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith(PLAN_REFERENCE_PREFIX)) {
    const reference = trimmed.slice(PLAN_REFERENCE_PREFIX.length).trim();
    if (!reference) {
      return null;
    }

    return resolveExecutePlanReference(reference, cwd, true);
  }

  const embeddedReference = extractEmbeddedPlanReference(trimmed);
  if (
    embeddedReference &&
    looksLikeEmbeddedPlanReference(embeddedReference.reference)
  ) {
    return resolveExecutePlanReference(
      embeddedReference.reference,
      cwd,
      true,
      embeddedReference.remainingArgs
    );
  }

  if (!isLikelyPlanFilePath(trimmed)) {
    return null;
  }

  return resolveExecutePlanReference(trimmed, cwd, false);
};

const readReferencedPlanSource = async (
  input: string,
  cwd: string
): Promise<{
  sourceText: string;
  sourceLabel: string;
  directive: string;
} | null> => {
  const resolvedPath = resolveExecutePlanPath(input, cwd);
  if (!resolvedPath) {
    return null;
  }

  try {
    const sourceText = await readFile(resolvedPath.filePath, "utf8");
    return {
      sourceText,
      sourceLabel: resolvedPath.displayPath,
      directive: resolvedPath.remainingArgs,
    };
  } catch (error) {
    if (!resolvedPath.explicitReference) {
      return null;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read plan file ${resolvedPath.displayPath}: ${message}`
    );
  }
};

export const resolveExecutePlanInput = async (
  input: string,
  cwd: string
): Promise<{
  planItems: string[];
  digestInput: ExecutePlanDigestInput | null;
}> => {
  const referencedPlan = await readReferencedPlanSource(input, cwd);
  if (referencedPlan) {
    const fallbackItems = parsePlanDocumentItems(referencedPlan.sourceText);
    return {
      planItems: fallbackItems,
      digestInput: {
        rawArgs: input,
        directive: referencedPlan.directive,
        sourceText: referencedPlan.sourceText,
        sourceLabel: referencedPlan.sourceLabel,
        fallbackItems,
      },
    };
  }

  return {
    planItems: parsePlanItems(input),
    digestInput: null,
  };
};

export const chooseWaveConcurrency = (items: string[]): number =>
  items.some((item) => RISKY_STEP_PATTERN.test(item))
    ? WRITE_HEAVY_CONCURRENCY
    : READ_ONLY_CONCURRENCY;

export const buildExecuteWorkerTask = (
  item: string,
  index: number,
  total: number
): string => buildMapTask(TASK_TEMPLATE, item, index, total);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

export const getExecuteStepResult = (
  value: unknown
): ExecuteStepResult | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const result = value as Partial<ExecuteStepResult>;
  if (
    result.status !== "done" &&
    result.status !== "blocked" &&
    result.status !== "needs_followup"
  ) {
    return null;
  }
  if (typeof result.summary !== "string") {
    return null;
  }
  if (!isStringArray(result.filesTouched)) {
    return null;
  }
  if (!isStringArray(result.validation)) {
    return null;
  }
  if (!isStringArray(result.followUps)) {
    return null;
  }
  if (!isStringArray(result.blockers)) {
    return null;
  }

  return {
    status: result.status,
    summary: result.summary,
    filesTouched: result.filesTouched,
    validation: result.validation,
    followUps: result.followUps,
    blockers: result.blockers,
  };
};

const stripJsonCodeFence = (value: string): string => {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
};

const buildExecutePlanDigestTask = (input: ExecutePlanDigestInput): string => {
  const extractedItems =
    input.fallbackItems.length > 0
      ? input.fallbackItems.map((item) => `- ${item}`).join("\n")
      : "- none extracted";

  return [
    "Rewrite this implementation plan into an ordered list of atomic repo tasks for /execute-wave.",
    'Return JSON only in this exact shape: {"items":["task 1","task 2"]}',
    "Rules:",
    "- Break broad bullets or phases into concrete executable tasks.",
    "- Each item must be a single repo task a worker can complete in one focused pass.",
    "- Preserve execution order and dependencies.",
    "- Use concise imperative phrasing.",
    "- Omit headings, milestones, and parent-orchestrator meta steps.",
    "- Keep already-atomic tasks mostly unchanged.",
    input.directive
      ? `User directive: ${input.directive}`
      : "User directive: execute the plan.",
    `Plan source: ${input.sourceLabel}`,
    `Initially extracted items:\n${extractedItems}`,
    `Full plan:\n${input.sourceText.trim()}`,
  ].join("\n\n");
};

const parseExecutePlanDigestResult = (outputText: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonCodeFence(outputText));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Plan digester returned invalid JSON: ${message}`);
  }

  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (parsed as { items?: unknown }).items
      : undefined;

  if (!Array.isArray(items)) {
    throw new Error("Plan digester result is missing items[]");
  }

  if (!items.every((item) => typeof item === "string")) {
    throw new Error("Plan digester items[] must contain only strings");
  }

  return normalizeExecutePlanItems(items);
};

export const digestExecutePlanItems = async (
  input: ExecutePlanDigestInput,
  ctx: ExtensionCommandContext
): Promise<string[]> => {
  const result = await runLlmTask({
    cwd: ctx.cwd,
    task: buildExecutePlanDigestTask(input),
  });

  if (result.isError) {
    throw new Error(
      result.errorMessage ?? result.stderr.trim() ?? "Plan digester failed"
    );
  }

  return parseExecutePlanDigestResult(result.outputText);
};

export const parseWorkerResult = (outputText: string): ExecuteStepResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonCodeFence(outputText));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Worker returned invalid JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Worker returned a non-object JSON value");
  }

  const result = parsed as Partial<ExecuteStepResult>;
  if (
    result.status !== "done" &&
    result.status !== "blocked" &&
    result.status !== "needs_followup"
  ) {
    throw new Error(
      `Worker result is missing a valid status (received ${String(result.status)})`
    );
  }
  if (typeof result.summary !== "string") {
    throw new Error("Worker result is missing a string summary");
  }
  if (!isStringArray(result.filesTouched)) {
    throw new Error("Worker result is missing filesTouched[]");
  }
  if (!isStringArray(result.validation)) {
    throw new Error("Worker result is missing validation[]");
  }
  if (!isStringArray(result.followUps)) {
    throw new Error("Worker result is missing followUps[]");
  }
  if (!isStringArray(result.blockers)) {
    throw new Error("Worker result is missing blockers[]");
  }

  return getExecuteStepResult(result)!;
};
