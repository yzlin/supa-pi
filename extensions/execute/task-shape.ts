import { type Static, Type } from "typebox";

import { isSupportedTestCommand } from "./tdd-evidence";

export const TASK_SHAPE_STRING_MAX_LENGTH = 2000;
export const TASK_SHAPE_PATH_MAX_LENGTH = 500;
export const TASK_SHAPE_MAX_ERRORS = 8;
export const TASK_SHAPE_MAX_WARNINGS = 1;
export const TASK_SHAPE_WARNING_MAX_LENGTH = 1000;

const NON_CANONICAL_PATH = "must be a canonical workspace-relative file path";
const INVALID_COMMAND =
  "redGreenCommand must be one supported direct managed-TDD runner command";
const PROTECTED_ROOTS = new Set([".pi", ".git", "node_modules"]);
const TASK_SHAPE_KEYS = new Set([
  "behavior",
  "redGreenCommand",
  "productionComponent",
  "mutations",
]);
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/;
const GLOB_CHARACTER = /[*?[\]{}]/;

export const TaskMutationSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("test"), Type.Literal("production")]),
    path: Type.String({ minLength: 1, maxLength: TASK_SHAPE_PATH_MAX_LENGTH }),
  },
  { additionalProperties: false }
);

const TaskShapeBaseSchema = Type.Object(
  {
    behavior: Type.String({
      minLength: 1,
      maxLength: TASK_SHAPE_STRING_MAX_LENGTH,
    }),
    redGreenCommand: Type.String({
      minLength: 1,
      maxLength: TASK_SHAPE_STRING_MAX_LENGTH,
    }),
    productionComponent: Type.String({
      minLength: 1,
      maxLength: TASK_SHAPE_STRING_MAX_LENGTH,
    }),
    mutations: Type.Array(TaskMutationSchema, { minItems: 2, maxItems: 6 }),
  },
  { additionalProperties: false }
);

export type TaskMutation = Static<typeof TaskMutationSchema>;
export type TaskShape = Static<typeof TaskShapeBaseSchema>;

export type TaskShapeValidationResult =
  | { ok: true; value: TaskShape }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || codePoint === 127;
  });
}

function isCanonicalWorkspaceFilePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.trim() !== path ||
    path.length > TASK_SHAPE_PATH_MAX_LENGTH ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    WINDOWS_DRIVE_PATH.test(path) ||
    GLOB_CHARACTER.test(path) ||
    containsControlCharacter(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return (
    segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== ".."
    ) && !PROTECTED_ROOTS.has(segments[0]!.toLowerCase())
  );
}

function boundedPush(errors: string[], error: string): void {
  if (errors.length < TASK_SHAPE_MAX_ERRORS) {
    errors.push(error.slice(0, 160));
  }
}

function validateBoundedString(
  object: Record<string, unknown>,
  key: "behavior" | "redGreenCommand" | "productionComponent",
  errors: string[]
): string | undefined {
  const value = object[key];
  if (typeof value !== "string") {
    boundedPush(errors, `${key} must be a string`);
    return;
  }
  if (value.trim().length === 0) {
    boundedPush(errors, `${key} must be non-blank`);
    return;
  }
  if (value.length > TASK_SHAPE_STRING_MAX_LENGTH) {
    boundedPush(
      errors,
      `${key} must be at most ${TASK_SHAPE_STRING_MAX_LENGTH} characters`
    );
    return;
  }
  return value;
}

function validationErrors(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["task must be an object"];
  }

  for (const key of Object.keys(value).sort()) {
    if (!TASK_SHAPE_KEYS.has(key)) {
      boundedPush(
        errors,
        `task contains unknown property ${JSON.stringify(key)}`
      );
    }
  }

  validateBoundedString(value, "behavior", errors);
  const redGreenCommand = validateBoundedString(
    value,
    "redGreenCommand",
    errors
  );
  validateBoundedString(value, "productionComponent", errors);
  if (redGreenCommand && !isSupportedTestCommand(redGreenCommand)) {
    boundedPush(errors, INVALID_COMMAND);
  }

  const mutationValues = value.mutations;
  if (!Array.isArray(mutationValues)) {
    boundedPush(errors, "mutations must be an array");
    return errors;
  }
  if (mutationValues.length < 2 || mutationValues.length > 6) {
    boundedPush(errors, "mutations must contain between 2 and 6 entries");
    return errors;
  }

  const mutations: TaskMutation[] = [];
  for (const [index, mutation] of mutationValues.entries()) {
    if (!isRecord(mutation)) {
      boundedPush(errors, `mutations[${index}] must be an object`);
      continue;
    }
    const keys = Object.keys(mutation);
    if (keys.some((key) => key !== "kind" && key !== "path")) {
      boundedPush(errors, `mutations[${index}] contains unknown properties`);
    }
    if (mutation.kind !== "test" && mutation.kind !== "production") {
      boundedPush(
        errors,
        `mutations[${index}].kind must be test or production`
      );
      continue;
    }
    if (
      typeof mutation.path !== "string" ||
      !isCanonicalWorkspaceFilePath(mutation.path)
    ) {
      boundedPush(errors, `mutations[${index}].path ${NON_CANONICAL_PATH}`);
      continue;
    }
    mutations.push({ kind: mutation.kind, path: mutation.path });
  }

  if (mutations.length !== mutationValues.length) {
    return errors;
  }
  const testTargets = new Set(
    mutations
      .filter((mutation) => mutation.kind === "test")
      .map((mutation) => mutation.path)
  );
  if (testTargets.size !== 1) {
    boundedPush(errors, "mutations must name exactly one distinct test target");
  }
  if (!mutations.some((mutation) => mutation.kind === "production")) {
    boundedPush(errors, "mutations must include at least one production entry");
  }
  let sawProduction = false;
  for (const mutation of mutations) {
    if (mutation.kind === "production") {
      sawProduction = true;
    } else if (sawProduction) {
      boundedPush(errors, "test mutations must precede production mutations");
      break;
    }
  }
  return errors;
}

export function compareMutationManifest(
  manifest: readonly TaskMutation[],
  observedTargets: readonly string[]
): string[] {
  let manifestIndex = 0;
  for (const target of observedTargets) {
    let matchIndex = manifestIndex;
    while (
      matchIndex < manifest.length &&
      manifest[matchIndex]?.path !== target
    ) {
      matchIndex += 1;
    }
    if (matchIndex === manifest.length) {
      const observed = JSON.stringify(observedTargets).slice(0, 800);
      return [
        `Observed authoritative mutation target order exceeded the declared mutation manifest: ${observed}`.slice(
          0,
          TASK_SHAPE_WARNING_MAX_LENGTH
        ),
      ];
    }
    manifestIndex = matchIndex + 1;
  }
  return [];
}

export function validateTaskShape(value: unknown): TaskShapeValidationResult {
  const errors = validationErrors(value);
  return errors.length === 0
    ? { ok: true, value: value as TaskShape }
    : { ok: false, errors };
}

export const TaskShapeSchema = Type.Refine(
  TaskShapeBaseSchema,
  (value) => validateTaskShape(value).ok,
  (value) => {
    const result = validateTaskShape(value);
    return result.ok === false ? result.errors[0]! : "invalid Task shape";
  }
);
