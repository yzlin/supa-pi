import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  generateAgent,
  isGenerated,
  needsOverride,
  type RepoAgent,
  resolveAgent,
} from "./agents";
import { atomicWrite, type Profile } from "./config";

export interface LiveEntry {
  kind: "generated" | "symlink" | "user";
  content?: string;
  target?: string;
  repoLink?: boolean;
  targetExists?: boolean;
}
export interface LiveState {
  kind: "missing" | "directory" | "repo-symlink";
  entries: Record<string, LiveEntry>;
}
type Action =
  | { kind: "mkdir" }
  | { kind: "convert" }
  | { kind: "remove"; filename: string }
  | { kind: "write"; filename: string; content: string }
  | { kind: "link"; filename: string; target: string };
export interface Plan {
  actions: Action[];
  warnings: string[];
}

function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function physical(path: string): string {
  if (stat(path)) {
    return realpathSync(path);
  }
  return join(physical(dirname(path)), basename(path));
}

function within(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

export function assertOutsideRepo(path: string, repoDir: string): void {
  if (within(physical(path), realpathSync(repoDir))) {
    throw new Error(
      `${path}: refusing to write inside repository agents directory`,
    );
  }
}

export function observeLive(liveDir: string, repoDir: string): LiveState {
  const live = stat(liveDir);
  if (!live) {
    return { kind: "missing", entries: {} };
  }
  if (live.isSymbolicLink()) {
    if (realpathSync(liveDir) === realpathSync(repoDir)) {
      return { kind: "repo-symlink", entries: {} };
    }
    throw new Error(`${liveDir}: refusing foreign agents directory symlink`);
  }
  if (!live.isDirectory()) {
    throw new Error(`${liveDir}: expected directory`);
  }
  const entries: Record<string, LiveEntry> = {};
  for (const filename of readdirSync(liveDir).sort()) {
    const path = join(liveDir, filename);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      const target = resolve(liveDir, readlinkSync(path));
      entries[filename] = {
        kind: "symlink",
        target,
        repoLink:
          within(target, resolve(repoDir)) ||
          within(target, realpathSync(repoDir)),
        targetExists: Boolean(stat(target)),
      };
    } else if (info.isFile()) {
      const content = readFileSync(path, "utf8");
      entries[filename] = {
        kind: isGenerated(content) ? "generated" : "user",
        content,
      };
    } else {
      entries[filename] = { kind: "user" };
    }
  }
  return { kind: "directory", entries };
}

// Pure: only the supplied repository snapshot and observed live state determine actions.
export function planAgents(
  agents: RepoAgent[],
  profile: Profile,
  state: LiveState,
): Plan {
  const desired = agents.map((agent) => {
    const values = resolveAgent(agent, profile);
    return { agent, override: needsOverride(agent, values), values };
  });
  if (state.kind === "repo-symlink" && !desired.some((item) => item.override)) {
    return { actions: [], warnings: [] };
  }
  const actions: Action[] = [];
  const warnings: string[] = [];
  if (state.kind === "repo-symlink") {
    actions.push({ kind: "convert" });
  }
  if (state.kind === "missing" && agents.length) {
    actions.push({ kind: "mkdir" });
  }
  for (const { agent, override, values } of desired) {
    const entry = state.entries[agent.filename];
    const owned =
      !entry ||
      entry.kind === "generated" ||
      (entry.kind === "symlink" &&
        entry.repoLink &&
        (entry.target === agent.path || !entry.targetExists));
    if (!owned) {
      if (override) {
        warnings.push(
          `${agent.name}: user-owned ${agent.filename} shadows the requested override; left untouched`,
        );
      }
      continue;
    }
    if (override) {
      const content = generateAgent(agent, values);
      if (entry?.kind !== "generated" || entry.content !== content) {
        actions.push({ kind: "write", filename: agent.filename, content });
      }
    } else if (entry?.kind !== "symlink" || entry.target !== agent.path) {
      actions.push({
        kind: "link",
        filename: agent.filename,
        target: agent.path,
      });
    }
  }
  const filenames = new Set(agents.map((agent) => agent.filename));
  for (const [filename, entry] of Object.entries(state.entries)) {
    if (
      !filenames.has(filename) &&
      (entry.kind === "generated" ||
        (entry.kind === "symlink" && entry.repoLink && !entry.targetExists))
    ) {
      actions.push({ kind: "remove", filename });
    }
  }
  return { actions, warnings };
}

export function applyPlan(
  liveDir: string,
  repoDir: string,
  plan: Plan,
): number {
  if (!plan.actions.length) {
    return 0;
  }
  const repo = realpathSync(repoDir);
  const converting = plan.actions[0]?.kind === "convert";
  // Resolve ancestors too: a lexical path check alone can write through a parent symlink.
  if (
    within(physical(liveDir), repo) &&
    !(
      converting &&
      lstatSync(liveDir).isSymbolicLink() &&
      realpathSync(liveDir) === repo
    )
  ) {
    throw new Error(
      `${liveDir}: refusing to write inside repository agents directory`,
    );
  }
  if (stat(liveDir)?.isSymbolicLink() && !converting) {
    throw new Error(`${liveDir}: refusing directory symlink writes`);
  }
  for (const action of plan.actions) {
    if (action.kind === "convert") {
      unlinkSync(liveDir);
      mkdirSync(liveDir);
      continue;
    }
    if (action.kind === "mkdir") {
      mkdirSync(liveDir, { recursive: true });
      continue;
    }
    if (basename(action.filename) !== action.filename) {
      throw new Error("Invalid agent filename");
    }
    const path = join(liveDir, action.filename);
    if (action.kind === "remove") {
      unlinkSync(path);
    } else if (action.kind === "write") {
      atomicWrite(path, action.content);
    } else {
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        symlinkSync(action.target, tmp);
        renameSync(tmp, path);
      } finally {
        rmSync(tmp, { force: true });
      }
    }
  }
  return plan.actions.length;
}
