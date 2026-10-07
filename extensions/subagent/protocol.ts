// Apache-2.0 adaptation of mitsuhiko/agent-stuff, d265b8e. Modified for SupaPi: run/schema-bound validated evidence.
import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";

import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

import {
  isRecord,
  isThinking,
  parseAgent,
  type AgentDefinition,
  type Thinking,
} from "./agents";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export function isJson(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJson);
  }
  return isRecord(value) && Object.values(value).every(isJson);
}
export function schemaHash(schema?: TSchema): string | undefined {
  return schema
    ? createHash("sha256").update(JSON.stringify(schema)).digest("hex")
    : undefined;
}
export function validateSchema(
  schema: unknown,
): asserts schema is Record<string, unknown> {
  if (!isRecord(schema) || !isJson(schema)) {
    throw new Error("Schema must be a JSON Schema object");
  }
  const strings = new Set([
    "$schema",
    "$id",
    "title",
    "description",
    "pattern",
    "format",
  ]);
  const numbers = new Set([
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minContains",
    "maxContains",
  ]);
  const booleans = new Set([
    "uniqueItems",
    "readOnly",
    "writeOnly",
    "deprecated",
  ]);
  const singular = new Set([
    "items",
    "contains",
    "additionalProperties",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
  ]);
  const arrays = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
  const maps = new Set(["properties", "patternProperties"]);
  const data = new Set(["const", "default", "examples", "enum"]);
  const types = new Set([
    "object",
    "array",
    "string",
    "number",
    "integer",
    "boolean",
    "null",
  ]);
  const visit = (value: unknown): void => {
    if (typeof value === "boolean") {
      return;
    }
    if (!isRecord(value)) {
      throw new Error("Invalid schema node");
    }
    for (const [key, field] of Object.entries(value)) {
      if (key === "type") {
        const names = Array.isArray(field) ? field : [field];
        if (
          !names.length ||
          names.some((item) => typeof item !== "string" || !types.has(item))
        ) {
          throw new Error("Invalid schema type");
        }
      } else if (key === "required") {
        if (
          !Array.isArray(field) ||
          field.some((item) => typeof item !== "string") ||
          new Set(field).size !== field.length
        ) {
          throw new Error("Invalid schema required");
        }
      } else if (strings.has(key)) {
        if (typeof field !== "string") {
          throw new Error(`Invalid schema ${key}`);
        }
        if (key === "pattern") {
          new RegExp(field);
        }
      } else if (numbers.has(key)) {
        if (
          typeof field !== "number" ||
          !Number.isFinite(field) ||
          (key === "multipleOf" && field <= 0)
        ) {
          throw new Error(`Invalid schema ${key}`);
        }
      } else if (booleans.has(key)) {
        if (typeof field !== "boolean") {
          throw new Error(`Invalid schema ${key}`);
        }
      } else if (singular.has(key)) {
        visit(field);
      } else if (arrays.has(key)) {
        if (!Array.isArray(field) || !field.length) {
          throw new Error(`Invalid schema ${key}`);
        }
        for (const item of field) {
          visit(item);
        }
      } else if (maps.has(key)) {
        if (!isRecord(field)) {
          throw new Error(`Invalid schema ${key}`);
        }
        for (const [name, child] of Object.entries(field)) {
          if (key === "patternProperties") {
            new RegExp(name);
          }
          visit(child);
        }
      } else if (!data.has(key)) {
        throw new Error(`Unsupported schema keyword: ${key}`);
      } else if (
        (key === "enum" || key === "examples") &&
        !Array.isArray(field)
      ) {
        throw new Error(`Invalid schema ${key}`);
      }
    }
  };
  visit(schema);
  // Exercise the installed validator now, not after a paid child starts.
  Check(schema, {});
}
export function validateStructured(schema: TSchema, value: unknown): JsonValue {
  if (!isJson(value) || !Check(schema, value)) {
    throw new Error(
      `Invalid StructuredOutput: ${JSON.stringify(Errors(schema, value)).slice(0, 4000)}`,
    );
  }
  return value;
}
export interface ChildConfig {
  version: 1;
  runId: string;
  parentSessionId: string;
  cwd: string;
  provider: string;
  model: string;
  thinking: Thinking;
  trusted: boolean;
  agent?: AgentDefinition;
  schema?: Record<string, unknown>;
  schemaHash?: string;
}
const childResultSchema = Type.Object(
  {
    version: Type.Literal(1),
    runId: Type.String(),
    parentSessionId: Type.String(),
    schemaHash: Type.Optional(Type.String()),
    status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
    output: Type.String(),
    error: Type.Optional(Type.String()),
    provider: Type.String(),
    model: Type.String(),
    thinking: Type.String(),
    agent: Type.Optional(Type.String()),
    structuredOutput: Type.Optional(Type.Unknown()),
    sessionFile: Type.Optional(Type.String()),
    finishedAt: Type.Number(),
  },
  { additionalProperties: false },
);
export type ChildResult = Static<typeof childResultSchema>;
export function validateResult(
  raw: unknown,
  config: ChildConfig,
): ChildResult & { structuredOutput?: JsonValue } {
  if (!Check(childResultSchema, raw)) {
    throw new Error("Malformed child result");
  }
  if (
    raw.runId !== config.runId ||
    raw.parentSessionId !== config.parentSessionId ||
    raw.schemaHash !== config.schemaHash ||
    raw.agent !== config.agent?.name ||
    raw.provider !== config.provider ||
    raw.model !== config.model ||
    raw.thinking !== config.thinking
  ) {
    throw new Error("Mismatched child result metadata");
  }
  const structuredOutput =
    config.schema && raw.status === "completed"
      ? validateStructured(config.schema, raw.structuredOutput)
      : undefined;
  return { ...raw, structuredOutput };
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temp, file);
}
export async function readChildConfig(file: string): Promise<ChildConfig> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.runId !== "string" ||
    typeof value.parentSessionId !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.model !== "string" ||
    !isThinking(value.thinking) ||
    typeof value.trusted !== "boolean"
  ) {
    throw new Error("Invalid child configuration");
  }
  if (value.schema !== undefined) {
    validateSchema(value.schema);
  }
  if (
    value.agent !== undefined &&
    (!isRecord(value.agent) ||
      typeof value.agent.name !== "string" ||
      typeof value.agent.body !== "string" ||
      typeof value.agent.file !== "string")
  ) {
    throw new Error("Invalid child role");
  }
  const agent =
    isRecord(value.agent) &&
    typeof value.agent.file === "string" &&
    typeof value.agent.body === "string"
      ? parseAgent(
          `---\n${JSON.stringify(value.agent)}\n---\n${value.agent.body}`,
          value.agent.file,
        )
      : undefined;
  if (value.schemaHash !== schemaHash(value.schema)) {
    throw new Error("Child schema hash mismatch");
  }
  return {
    agent,
    version: 1,
    runId: value.runId,
    parentSessionId: value.parentSessionId,
    cwd: value.cwd,
    provider: value.provider,
    model: value.model,
    thinking: value.thinking,
    trusted: value.trusted,
    schema: isRecord(value.schema) ? value.schema : undefined,
    schemaHash:
      typeof value.schemaHash === "string" ? value.schemaHash : undefined,
  };
}
export async function protectFile(file: string): Promise<void> {
  await chmod(file, 0o600);
}
