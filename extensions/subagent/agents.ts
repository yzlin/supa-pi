// Apache-2.0 adaptation of mitsuhiko/agent-stuff, d265b8e. Modified for SupaPi: strict trusted role discovery.
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];
export interface AgentDefinition {
  name: string;
  description?: string;
  body: string;
  model?: string;
  thinking?: Thinking;
  tools?: string[];
  extensions?: boolean | string[];
  skills?: boolean | string[];
  disallowed_tools?: string[];
  caveman?: boolean;
  file: string;
  source?: "project" | "global";
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function within(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
export function isThinking(value: unknown): value is Thinking {
  return (
    typeof value === "string" &&
    THINKING_LEVELS.some((level) => level === value)
  );
}
function textField(
  raw: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${key}`);
  }
  return value.trim();
}
function list(
  value: unknown,
  key: string,
  special = false,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (special && value === "*") {
    return undefined;
  }
  if (special && value === "none") {
    return [];
  }
  const items =
    typeof value === "string"
      ? value.split(",").map((item) => item.trim())
      : value;
  if (
    !Array.isArray(items) ||
    items.some(
      (item) => typeof item !== "string" || !/^[a-zA-Z0-9_:-]+$/.test(item),
    ) ||
    new Set(items).size !== items.length
  ) {
    throw new Error(`Invalid ${key} list`);
  }
  return items;
}
function resources(
  value: unknown,
  key: string,
): boolean | string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (item) => typeof item !== "string" || !item.trim() || item.includes("\0"),
    )
  ) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}
function normalizeWildcard(text: string): string {
  // A bare wildcard is an approved tools shorthand, not a YAML alias.
  return text.replace(/^tools:[ \t]*\*[ \t]*$/m, 'tools: "*"');
}
export function parseAgent(text: string, file: string): AgentDefinition {
  if (
    text.startsWith("---") &&
    !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)
  ) {
    throw new Error(`Malformed frontmatter: ${file}`);
  }
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
    normalizeWildcard(text),
  );
  if (!isRecord(frontmatter)) {
    throw new Error(`Invalid frontmatter: ${file}`);
  }
  const name = textField(frontmatter, "name") ?? path.basename(file, ".md");
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid agent name: ${name}`);
  }
  const rawThinking = frontmatter.thinking;
  let thinking: Thinking | undefined;
  if (rawThinking !== undefined) {
    if (!isThinking(rawThinking)) {
      throw new Error("Invalid thinking");
    }
    thinking = rawThinking;
  }
  const rawCaveman = frontmatter.caveman;
  let caveman: boolean | undefined;
  if (rawCaveman !== undefined) {
    if (typeof rawCaveman !== "boolean") {
      throw new Error("Invalid caveman");
    }
    caveman = rawCaveman;
  }
  const model = textField(frontmatter, "model");
  if (model && !/^[^/\s]+\/[^\s]+$/.test(model)) {
    throw new Error("Invalid agent model: expected provider/model");
  }
  return {
    name,
    file,
    body,
    description: textField(frontmatter, "description"),
    model,
    thinking,
    caveman,
    tools: list(frontmatter.tools, "tools", true),
    disallowed_tools: list(frontmatter.disallowed_tools, "disallowed_tools"),
    extensions: resources(frontmatter.extensions, "extensions"),
    skills: resources(frontmatter.skills, "skills"),
  };
}
interface Candidate {
  name: string;
  agent?: AgentDefinition;
  error?: string;
}
async function candidates(
  directory: string,
  source: "project" | "global",
  cwd: string,
): Promise<Candidate[]> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const result: Candidate[] = [];
  for (const file of files.filter((item) => item.endsWith(".md")).sort()) {
    const full = path.join(directory, file);
    let name = path.basename(file, ".md");
    let indexed = false;
    try {
      const resolved = await realpath(full);
      if (
        source === "project" &&
        (!within(await realpath(cwd), await realpath(directory)) ||
          !within(await realpath(directory), resolved))
      ) {
        throw new Error("Project agent symlink escape");
      }
      const text = await readFile(resolved, "utf8");
      // Recover the advertised name before validating controls so invalid shadows fail closed.
      const { frontmatter } = parseFrontmatter<Record<string, unknown>>(
        normalizeWildcard(text),
      );
      if (isRecord(frontmatter)) {
        name = textField(frontmatter, "name") ?? name;
      }
      indexed = true;
      result.push({ name, agent: { ...parseAgent(text, resolved), source } });
    } catch (error) {
      if (!indexed) {
        throw new Error(
          `Blocked role discovery: ${full}: ${error instanceof Error ? error.message : "Unreadable role"}`,
          { cause: error },
        );
      }
      result.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
export async function loadAgent(
  name: string,
  cwd: string,
  global: string,
  trusted: boolean,
): Promise<AgentDefinition> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("Invalid agent name");
  }
  const project = (
    await candidates(path.join(cwd, ".pi", "agents"), "project", cwd)
  ).filter((item) => item.name === name);
  if (project.length && !trusted) {
    throw new Error(`Project trust required for agent ${name}`);
  }
  const matches = project.length
    ? project
    : (await candidates(global, "global", cwd)).filter(
        (item) => item.name === name,
      );
  if (!matches.length) {
    throw new Error(`Unknown agent: ${name}`);
  }
  if (matches.length !== 1) {
    throw new Error(`Ambiguous agent: ${name}`);
  }
  const selected = matches[0];
  if (!selected.agent) {
    throw new Error(`Blocked agent ${name}: ${selected.error}`);
  }
  return selected.agent;
}

export async function resolveAgentResources(
  agent: AgentDefinition,
  cwd: string,
): Promise<AgentDefinition> {
  const workspace = await realpath(cwd);
  const resolve = async (
    paths: boolean | string[] | undefined,
  ): Promise<boolean | string[] | undefined> => {
    if (!Array.isArray(paths)) {
      return paths;
    }
    const result: string[] = [];
    for (const resource of paths) {
      const resolved = await realpath(
        path.resolve(path.dirname(agent.file), resource),
      );
      if (agent.source === "project" && !within(workspace, resolved)) {
        throw new Error("Project role resource path escape");
      }
      result.push(resolved);
    }
    return result;
  };
  return {
    ...agent,
    extensions: await resolve(agent.extensions),
    skills: await resolve(agent.skills),
  };
}
