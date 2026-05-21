import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { ManagedSkillEntry, SkillSourceIdentity } from "./core";

export type SkillInventoryKind = "managed" | "bundled";
export type SkillInventoryDirtyStatus = "clean" | "dirty";

export interface SkillInventoryItem {
  id: string;
  name: string;
  description: string;
  kind: SkillInventoryKind;
  path: string;
  displayPath: string;
  source?: SkillSourceIdentity;
  dirtyStatus?: SkillInventoryDirtyStatus;
  skillContent?: string;
}

export interface SkillInventoryModel {
  managed: SkillInventoryItem[];
  bundled: SkillInventoryItem[];
  all: SkillInventoryItem[];
}

export interface BuildSkillInventoryOptions {
  managed: ManagedSkillEntry[];
  bundledSkillPaths: string[];
  dirtyIds?: ReadonlySet<string>;
  cwd?: string;
}

export interface SkillListFilter {
  query?: string;
  kind?: SkillInventoryKind | "all";
}

export interface SkillPreviewModel {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  kind: SkillInventoryKind;
  path: string;
  source?: string;
  dirty: boolean;
  skillContent?: string;
}

export type SkillCommandAction =
  | "list"
  | "search"
  | "install"
  | "update"
  | "remove"
  | "unknown";

export interface SkillCommandInitialState {
  action: SkillCommandAction;
  operand: string;
  rawArgs: string;
  enteredSubcommand: string;
}

const PATH_SEPARATOR_RE = /[\\/]/;
const WHITESPACE_RE = /\s+/;
const KNOWN_SKILL_COMMANDS = new Set([
  "list",
  "search",
  "install",
  "update",
  "remove",
]);

function displayPath(path: string, cwd = process.cwd()): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function bundledNameFromPath(skillPath: string): string {
  return dirname(skillPath).split(PATH_SEPARATOR_RE).pop() || skillPath;
}

function readSkillContent(skillDir: string): string | undefined {
  const skillPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillPath)) {
    return undefined;
  }
  try {
    return readFileSync(skillPath, "utf8").trim();
  } catch {
    return undefined;
  }
}

export function buildSkillInventoryModel({
  managed,
  bundledSkillPaths,
  dirtyIds = new Set<string>(),
  cwd,
}: BuildSkillInventoryOptions): SkillInventoryModel {
  const managedItems = managed.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    kind: "managed" as const,
    path: skill.installPath,
    displayPath: displayPath(skill.installPath, cwd),
    source: skill.source,
    dirtyStatus: dirtyIds.has(skill.id)
      ? ("dirty" as const)
      : ("clean" as const),
    skillContent: readSkillContent(skill.installPath),
  }));
  const bundledItems = bundledSkillPaths.map((skillPath) => {
    const skillDir = dirname(skillPath);
    return {
      id: displayPath(skillDir, cwd),
      name: bundledNameFromPath(skillPath),
      description: "Bundled/read-only skill",
      kind: "bundled" as const,
      path: skillDir,
      displayPath: displayPath(skillDir, cwd),
      skillContent: readSkillContent(skillDir),
    };
  });
  return {
    managed: managedItems,
    bundled: bundledItems,
    all: [...managedItems, ...bundledItems],
  };
}

export function filterSkillInventory(
  inventory: SkillInventoryModel,
  filter: SkillListFilter = {}
): SkillInventoryModel {
  const kind = filter.kind ?? "all";
  const query = (filter.query ?? "").trim().toLowerCase();
  const items = inventory.all.filter((item) => {
    if (kind !== "all" && item.kind !== kind) {
      return false;
    }
    if (!query) {
      return true;
    }
    return [item.id, item.name, item.description, item.displayPath]
      .join("\n")
      .toLowerCase()
      .includes(query);
  });
  return {
    managed: items.filter((item) => item.kind === "managed"),
    bundled: items.filter((item) => item.kind === "bundled"),
    all: items,
  };
}

function sourceLabel(item: SkillInventoryItem): string | undefined {
  if (!item.source) {
    return undefined;
  }
  const { owner, path, ref, repo, subpath, url } = item.source;
  if (!owner) {
    return url ?? path;
  }
  if (!subpath) {
    return `${owner}/${repo}`;
  }
  return `${owner}/${repo}/tree/${ref}/${subpath}`;
}

export function buildSkillPreviewModel(
  item: SkillInventoryItem
): SkillPreviewModel {
  return {
    id: item.id,
    title: item.name,
    subtitle:
      item.kind === "managed" ? "Managed skill" : "Bundled/read-only skill",
    description: item.description,
    kind: item.kind,
    path: item.displayPath,
    source: sourceLabel(item),
    dirty: item.dirtyStatus === "dirty",
    skillContent: item.skillContent,
  };
}

export function parseSkillCommandInitialState(
  rawArgs = ""
): SkillCommandInitialState {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return { action: "list", operand: "", rawArgs, enteredSubcommand: "list" };
  }
  const [candidate = "", ...rest] = trimmed.split(WHITESPACE_RE);
  const action = KNOWN_SKILL_COMMANDS.has(candidate)
    ? (candidate as SkillCommandAction)
    : "unknown";
  return {
    action,
    operand: rest.join(" ").trim(),
    rawArgs,
    enteredSubcommand: candidate,
  };
}
