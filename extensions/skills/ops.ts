import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyRemovePlan,
  computeSkillFilesHash,
  copyInstallPlan,
  createGithubRepoTreeCacheSession,
  createSkillsManagerPaths,
  detectDirtySkills,
  discoverBundledSkillPaths,
  fetchGithubRepoTreeSnapshot,
  fetchSkillsShSearchCache,
  findListedSkillSourceDir,
  type GithubRepoTreeCacheSession,
  type GithubRepoTreeSnapshot,
  githubRemoteSlug,
  githubSkillFolderHash,
  githubSkillOwnedFilePaths,
  githubSkillRootsFromTree,
  installSelectedSkillsSequentially,
  type ListedSkillSource,
  listSkillsInSource,
  type ManagedSkillEntry,
  type ManagedSkillsManifest,
  materializeResolvedSkillSource,
  parseSkillSource,
  planInstallSkill,
  planRemoveSkill,
  type RemoteSkillMetadata,
  type ResolvedSkillSource,
  readManagedManifest,
  readSkillsSearchCache,
  resolveGithubSkillPathFromTree,
  type SkillSourceIdentity,
  type SkillsManagerPaths,
  searchCachedSkills,
  sourceIdentityForGithubSkillRoot,
  withSkillsWriteLock,
  writeManagedManifest,
  writeSkillsSearchCache,
} from "./core";
import { buildSkillInventoryModel } from "./model";

const OPS_DIR = dirname(fileURLToPath(import.meta.url));
export const BUNDLED_SKILLS_DIR = join(OPS_DIR, "..", "..", "skills");
const RELOAD_MESSAGE = "Changes apply after /reload or next session.";
const SELECTED_ID_RE = /\(([^)]+)\)$/;
const TRAILING_ZERO_DECIMAL_RE = /\.0$/;
const TRAILING_SLASH_RE = /\/$/;
const BACKSLASH_RE = /\\/g;

export type NotifyLevel = "info" | "warning" | "error";

/** Caller-supplied interaction seam; `/skill` adapts ctx.ui, the CLI adapts the terminal. */
export interface Prompter {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level: NotifyLevel): void;
  /** Multi-skill picker for repo-root installs; returns selected entry ids. */
  pickSkills?(
    entries: ListedSkillSource[],
    manifest: ManagedSkillsManifest,
  ): Promise<string[] | undefined>;
  /** Progress label for long operations. */
  progress?(label: string): void;
  /** Remaining pending update count after update checks. */
  setUpdateCount?(count: number): void;
}

/** Explicit choices that skip the corresponding prompts. */
export interface OpsChoices {
  /** Confirm every confirmation (including dirty overwrite/remove). */
  yes?: boolean;
  /** Update all / install all skills in a multi-skill source. */
  all?: boolean;
  /** Pick skills by name/id. */
  skillNames?: string[];
  paths?: SkillsManagerPaths;
}

function sourceText(skill: ManagedSkillEntry): string {
  if (!skill.source.owner) {
    return skill.source.url ?? skill.source.path;
  }
  if (!skill.source.subpath) {
    const refSuffix =
      skill.source.ref && skill.source.ref !== "HEAD"
        ? `#${skill.source.ref}`
        : "";
    return `${skill.source.owner}/${skill.source.repo}${refSuffix}`;
  }
  return `${skill.source.owner}/${skill.source.repo}/tree/${skill.source.ref}/${skill.source.subpath}`;
}

function resolvedSourceForSkill(skill: ManagedSkillEntry): ResolvedSkillSource {
  const source = sourceText(skill);
  if (
    skill.source.type === "github" &&
    skill.source.owner &&
    skill.source.repo
  ) {
    const { owner, repo, ref = "HEAD", subpath = "" } = skill.source;
    return {
      identity: sourceIdentityForGithubSkillRoot(
        { identity: skill.source, displayName: source },
        subpath,
      ),
      displayName: source,
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${subpath ? `${subpath}/` : ""}SKILL.md`,
    };
  }
  return parseSkillSource(source);
}

function shortPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function remoteSkillSource(skill: RemoteSkillMetadata): string {
  return skill.source || skill.url || skill.repository || "";
}

function formatInstallCount(installs: number): string {
  if (installs >= 1_000_000) {
    return `${(installs / 1_000_000).toFixed(1).replace(TRAILING_ZERO_DECIMAL_RE, "")}M installs`;
  }
  if (installs >= 1000) {
    return `${(installs / 1000).toFixed(1).replace(TRAILING_ZERO_DECIMAL_RE, "")}K installs`;
  }
  return `${installs} install${installs === 1 ? "" : "s"}`;
}

export function remoteSkillLabel(skill: RemoteSkillMetadata): string {
  const source = remoteSkillSource(skill);
  const installText =
    typeof skill.installs === "number"
      ? ` — ${formatInstallCount(skill.installs)}`
      : "";
  return `${skill.name} — ${source}${installText}`;
}

function isDirectSourceQuery(query: string): boolean {
  return (
    query.includes("/") || query.startsWith(".") || query.startsWith("http")
  );
}

export interface ManagedSkillListEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  installPath: string;
  dirty: boolean;
}

/** Pure data view of managed skills for table/JSON rendering. */
export function listManagedSkills(
  paths: SkillsManagerPaths = createSkillsManagerPaths(),
): ManagedSkillListEntry[] {
  const manifest = readManagedManifest(paths.manifestPath);
  const dirtyIds = new Set(detectDirtySkills(manifest).map((s) => s.id));
  return manifest.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: sourceText(skill),
    installPath: skill.installPath,
    dirty: dirtyIds.has(skill.id),
  }));
}

export function formatList(managed: ManagedSkillEntry[]): string {
  const dirty = detectDirtySkills({ version: 1, skills: managed });
  const dirtyIds = new Set(dirty.map((skill) => skill.id));
  const managedLines = managed.length
    ? managed.map((skill) => {
        const marker = dirtyIds.has(skill.id) ? " dirty" : "";
        return `• ${skill.name} (${skill.id})${marker}\n  ${skill.description}\n  ${shortPath(skill.installPath)}`;
      })
    : ["No managed skills installed."];
  const inventory = buildSkillInventoryModel({
    managed,
    bundledSkillPaths: discoverBundledSkillPaths(BUNDLED_SKILLS_DIR),
  });
  const bundledLines = inventory.bundled.length
    ? inventory.bundled.map((skill) => `• ${skill.displayPath}`)
    : ["No bundled skills found."];
  return [
    "Managed skills",
    ...managedLines,
    "",
    "Bundled/read-only skills",
    ...bundledLines,
  ].join("\n");
}

function dirtyWarning(
  skill: ManagedSkillEntry,
  changedFiles: string[],
): string {
  const files = changedFiles.slice(0, 5).join(", ");
  const suffix =
    changedFiles.length > 5 ? `, +${changedFiles.length - 5} more` : "";
  return `${skill.name} has local changes or missing managed files (${files}${suffix}). Continue?`;
}

function confirmCleanOverwrite(
  prompter: Prompter,
  skill: ManagedSkillEntry,
  manifest: ManagedSkillsManifest,
  yes = false,
): Promise<boolean> {
  const dirty = detectDirtySkills(manifest).find(
    (entry) => entry.id === skill.id,
  );
  if (!dirty || yes) {
    return Promise.resolve(true);
  }
  return prompter.confirm(
    "Overwrite dirty skill",
    dirtyWarning(skill, dirty.changedFiles),
  );
}

async function selectSkillSourceDir(
  prompter: Prompter,
  entries: ListedSkillSource[],
): Promise<string | undefined> {
  if (entries.length === 1) {
    return entries[0]?.sourceDir;
  }
  const selected = await prompter.select(
    "Install skill",
    entries.map((listed) => `${listed.name} — ${listed.sourceDir}`),
  );
  return entries.find((listed) => selected?.endsWith(listed.sourceDir))
    ?.sourceDir;
}

/** Strict name/id match for explicit choices (no single-entry fallback). */
function namedSourceDir(entries: ListedSkillSource[], name: string): string {
  const entry = entries.find(
    (listed) =>
      listed.id === name ||
      listed.name === name ||
      listed.id === name.toLowerCase(),
  );
  if (!entry) {
    throw new Error(`Skill not found in source: ${name}`);
  }
  return entry.sourceDir;
}

async function selectSkillSourceDirs(
  prompter: Prompter,
  entries: ListedSkillSource[],
  source: string,
  sourceRoot: string,
  manifest: ManagedSkillsManifest,
  choices: OpsChoices,
): Promise<string[] | undefined> {
  if (choices.all) {
    return entries.map((entry) => entry.sourceDir);
  }
  if (choices.skillNames?.length) {
    return choices.skillNames.map((name) => namedSourceDir(entries, name));
  }
  if (!prompter.pickSkills) {
    if (entries.length === 1) {
      return entries[0] ? [entries[0].sourceDir] : [];
    }
    const first = entries[0];
    const suggestion = first
      ? `${source.replace(TRAILING_SLASH_RE, "")}/tree/${parseSkillSource(source).identity.ref ?? "HEAD"}/${relative(sourceRoot, first.sourceDir).replace(BACKSLASH_RE, "/")}`
      : source;
    prompter.notify(
      `Multiple skills found. Run /skill install ${suggestion} to install one skill.`,
      "warning",
    );
    return;
  }
  const selectedIds = await prompter.pickSkills(entries, manifest);
  if (!selectedIds) {
    return;
  }
  if (selectedIds.length === 0) {
    prompter.notify("Select at least one skill to install.", "warning");
    return;
  }
  const selected = new Set(selectedIds);
  return entries
    .filter((entry) => selected.has(entry.id))
    .map((entry) => entry.sourceDir);
}

function remoteIdentityForEntry(
  resolved: ResolvedSkillSource,
  sourceRoot: string,
  entry: ListedSkillSource,
) {
  if (resolved.identity.type !== "github") {
    return resolved.identity;
  }
  const relativeEntry = relative(sourceRoot, entry.sourceDir).replace(
    BACKSLASH_RE,
    "/",
  );
  const subpath = [resolved.identity.subpath, relativeEntry]
    .filter(Boolean)
    .join("/");
  return sourceIdentityForGithubSkillRoot(resolved, subpath);
}

type GithubSkillMetadata = Pick<
  ManagedSkillEntry,
  "remoteSlug" | "skillFolderHash" | "skillPath"
>;

function githubMetadataForIdentity(
  identity: SkillSourceIdentity,
  snapshot: GithubRepoTreeSnapshot | undefined,
): GithubSkillMetadata {
  if (
    identity.type !== "github" ||
    !identity.owner ||
    !identity.repo ||
    identity.subpath === undefined
  ) {
    return {};
  }
  const metadata: GithubSkillMetadata = {
    remoteSlug: githubRemoteSlug(identity),
    skillPath: identity.subpath,
  };
  if (!(snapshot?.revision && !snapshot.stale)) {
    return metadata;
  }
  return {
    ...metadata,
    skillFolderHash:
      githubSkillFolderHash(snapshot.tree, identity.subpath) ?? undefined,
  };
}

function applyInstalledMetadata(
  paths: SkillsManagerPaths,
  patches: Map<string, GithubSkillMetadata>,
): ManagedSkillEntry[] {
  const manifest = readManagedManifest(paths.manifestPath);
  const next = {
    version: manifest.version,
    skills: manifest.skills.map((skill) => ({
      ...skill,
      ...(patches.get(skill.id) ?? {}),
    })),
  };
  writeManagedManifest(paths.manifestPath, next);
  return next.skills;
}

function formatInstalledMessage(installed: { name: string }[]): string {
  const names = installed.map((entry) => entry.name).join(", ");
  return `Installed ${installed.length} skill${installed.length === 1 ? "" : "s"}: ${names}. ${RELOAD_MESSAGE}`;
}

function exactGithubSourceResolutionError(
  requestedSkillName: string | undefined,
  source: string,
): Error {
  return new Error(
    `Unable to resolve ${requestedSkillName} to one exact GitHub skill source from ${source}.`,
  );
}

interface MaterializedRemoteSource {
  sourceRoot: string;
  githubTreeSnapshot?: GithubRepoTreeSnapshot;
}

export interface InstallOptions extends OpsChoices {
  /** False skips dirty-overwrite confirmations (update path confirms earlier). */
  confirmDirty?: boolean;
  requestedSkillName?: string;
  resolvedSource?: ResolvedSkillSource;
  materializedSource?: MaterializedRemoteSource;
  skipSuccessNotify?: boolean;
}

export async function installLocalSource(
  prompter: Prompter,
  source: string,
  options: InstallOptions = {},
): Promise<ManagedSkillEntry[] | undefined> {
  const paths = options.paths ?? createSkillsManagerPaths();
  const confirmDirty = options.confirmDirty ?? true;
  const { materializedSource, yes } = options;
  const multiNameChoice = (options.skillNames?.length ?? 0) > 1;
  const requestedSkillName =
    options.requestedSkillName ??
    (options.skillNames?.length === 1 ? options.skillNames[0] : undefined);
  const resolved = options.resolvedSource ?? parseSkillSource(source);
  let exactSourceIdentity =
    materializedSource && resolved.identity.type === "github"
      ? resolved.identity
      : undefined;
  let githubTreeSnapshot = materializedSource?.githubTreeSnapshot;
  const shouldResolveExactSource =
    !resolved.localPath &&
    resolved.identity.type === "github" &&
    !resolved.identity.subpath &&
    !!requestedSkillName;
  const sourceRoot =
    resolved.localPath ??
    materializedSource?.sourceRoot ??
    (await materializeResolvedSkillSource(resolved, paths, fetch, {
      requestedSkillName,
      exactSubpath:
        resolved.identity.type === "github" && !!resolved.identity.subpath,
      onExactSourceResolved: (identity) => {
        exactSourceIdentity = identity;
      },
      onGithubTreeResolved: (snapshot) => {
        githubTreeSnapshot = snapshot;
      },
    }));
  if (shouldResolveExactSource && !exactSourceIdentity) {
    throw exactGithubSourceResolutionError(requestedSkillName, source);
  }
  const entries = listSkillsInSource(sourceRoot);
  if (entries.length === 0) {
    if (options.skipSuccessNotify) {
      throw new Error("No SKILL.md files found in source.");
    }
    prompter.notify("No SKILL.md files found in source.", "warning");
    return;
  }
  const isGithubRepoRootInstall =
    !resolved.localPath &&
    resolved.identity.type === "github" &&
    !resolved.identity.subpath &&
    !requestedSkillName;
  const isRepoShorthand = isGithubRepoRootInstall && !source.startsWith("http");
  const hasCustomInstallPicker = !!prompter.pickSkills;
  if (
    isRepoShorthand ||
    (isGithubRepoRootInstall && hasCustomInstallPicker) ||
    (options.all && !requestedSkillName) ||
    multiNameChoice
  ) {
    const selectedSourceDirs = await selectSkillSourceDirs(
      prompter,
      entries,
      source,
      sourceRoot,
      readManagedManifest(paths.manifestPath),
      options,
    );
    if (!selectedSourceDirs || selectedSourceDirs.length === 0) {
      return;
    }
    if (confirmDirty) {
      const currentManifest = readManagedManifest(paths.manifestPath);
      for (const sourceDir of selectedSourceDirs) {
        const plan = planInstallSkill(sourceDir, paths, currentManifest);
        const existing = currentManifest.skills.find(
          (skill) => skill.id === plan.id,
        );
        if (existing) {
          const ok = await confirmCleanOverwrite(
            prompter,
            existing,
            currentManifest,
            yes,
          );
          if (!ok) {
            return;
          }
        }
      }
    }
    const identities = new Map<string, SkillSourceIdentity>();
    const metadata = new Map<string, GithubSkillMetadata>();
    for (const entry of entries) {
      if (!selectedSourceDirs.includes(entry.sourceDir)) {
        continue;
      }
      if (resolved.localPath) {
        // Local entries keep their own directory identity.
        continue;
      }
      const identity = remoteIdentityForEntry(resolved, sourceRoot, entry);
      identities.set(entry.id, identity);
      metadata.set(
        entry.id,
        githubMetadataForIdentity(identity, githubTreeSnapshot),
      );
    }
    const result = withSkillsWriteLock(paths, () => {
      const installedResult = installSelectedSkillsSequentially(
        entries,
        selectedSourceDirs,
        paths,
        (entry) => identities.get(entry.id),
        (entry) => {
          const identity = identities.get(entry.id);
          if (!(identity?.type === "github" && githubTreeSnapshot)) {
            return;
          }
          return githubSkillOwnedFilePaths(
            githubTreeSnapshot.tree,
            identity.subpath ?? "",
          );
        },
      );
      if (installedResult.installed.length > 0) {
        const latest = applyInstalledMetadata(paths, metadata);
        return {
          ...installedResult,
          installed: latest.filter((skill) =>
            installedResult.installed.some((entry) => entry.id === skill.id),
          ),
        };
      }
      return installedResult;
    });
    if (result.failed) {
      throw new Error(
        `Failed to install ${result.failed.sourceDir}: ${
          result.failed.error instanceof Error
            ? result.failed.error.message
            : String(result.failed.error)
        }`,
      );
    }
    if (!options.skipSuccessNotify) {
      prompter.notify(formatInstalledMessage(result.installed), "info");
    }
    return result.installed;
  }
  let choice: string | undefined;
  if (options.requestedSkillName) {
    choice = findListedSkillSourceDir(entries, options.requestedSkillName);
  } else if (requestedSkillName && resolved.localPath) {
    choice = namedSourceDir(entries, requestedSkillName);
  } else if (requestedSkillName) {
    choice = findListedSkillSourceDir(entries, requestedSkillName);
    if (!(choice || shouldResolveExactSource)) {
      throw new Error(`Skill not found in source: ${requestedSkillName}`);
    }
  } else {
    choice = await selectSkillSourceDir(prompter, entries);
  }
  if (!choice) {
    if (shouldResolveExactSource) {
      throw exactGithubSourceResolutionError(requestedSkillName, source);
    }
    return;
  }
  const plan = planInstallSkill(choice, paths);
  const currentManifest = readManagedManifest(paths.manifestPath);
  const existing = currentManifest.skills.find((skill) => skill.id === plan.id);
  if (confirmDirty && existing) {
    const ok = await confirmCleanOverwrite(
      prompter,
      existing,
      currentManifest,
      yes,
    );
    if (!ok) {
      return;
    }
  }
  const selectedEntry = entries.find((entry) => entry.sourceDir === choice);
  if (!selectedEntry) {
    throw new Error(`Selected skill source is unavailable: ${choice}`);
  }
  const finalSource =
    exactSourceIdentity ??
    (!resolved.localPath && resolved.identity.type === "github"
      ? remoteIdentityForEntry(resolved, sourceRoot, selectedEntry)
      : resolved.identity);
  const githubMetadata = githubMetadataForIdentity(
    finalSource,
    githubTreeSnapshot,
  );
  const installed = withSkillsWriteLock(paths, () => {
    const entry = copyInstallPlan(plan, paths);
    if (!resolved.localPath) {
      const manifest = readManagedManifest(paths.manifestPath);
      const next = {
        version: manifest.version,
        skills: manifest.skills.map((skill) =>
          skill.id === entry.id
            ? { ...entry, source: finalSource, ...githubMetadata }
            : skill,
        ),
      };
      writeManagedManifest(paths.manifestPath, next);
      return next.skills.find((skill) => skill.id === entry.id) ?? entry;
    }
    return entry;
  });
  if (!options.skipSuccessNotify) {
    prompter.notify(formatInstalledMessage([installed]), "info");
  }
  return [installed];
}

interface PendingSkillUpdate {
  skill: ManagedSkillEntry;
  source: string;
  resolvedSource: ResolvedSkillSource;
}

interface PendingSkillSourceHeal {
  skill: ManagedSkillEntry;
  source?: SkillSourceIdentity;
  metadata?: GithubSkillMetadata;
}

interface PendingSkillUpdateFailure {
  skill: ManagedSkillEntry;
  source: string;
  message: string;
}

export interface RemoteUpdateCheckResult {
  updates: PendingSkillUpdate[];
  sourceHeals: PendingSkillSourceHeal[];
  failures: PendingSkillUpdateFailure[];
}

function formatUpdateFailures(failures: PendingSkillUpdateFailure[]): string {
  const suffix = failures.length === 1 ? "" : "s";
  return `Unable to check ${failures.length} skill update source${suffix}: ${failures
    .map(
      ({ skill, source, message }) => `${skill.name} (${source}): ${message}`,
    )
    .join("; ")}`;
}

function applySourceHeals(
  paths: SkillsManagerPaths,
  sourceHeals: PendingSkillSourceHeal[],
): void {
  withSkillsWriteLock(paths, () => {
    const latestManifest = readManagedManifest(paths.manifestPath);
    writeManagedManifest(paths.manifestPath, {
      version: latestManifest.version,
      skills: latestManifest.skills.map((entry) => {
        const heal = sourceHeals.find(({ skill }) => skill.id === entry.id);
        return heal
          ? {
              ...entry,
              ...(heal.source ? { source: heal.source } : {}),
              ...(heal.metadata ?? {}),
            }
          : entry;
      }),
    });
  });
}

function githubUpdateGroupKey(skill: ManagedSkillEntry): string | null {
  if (
    skill.source.type !== "github" ||
    !skill.source.owner ||
    !skill.source.repo
  ) {
    return null;
  }
  return `${skill.source.owner}/${skill.source.repo}#${skill.source.ref ?? "HEAD"}`;
}

function exactGithubResolvedSource(
  skill: ManagedSkillEntry,
  skillPath: string,
): ResolvedSkillSource {
  const { owner, repo, ref = "HEAD" } = skill.source;
  if (!(owner && repo)) {
    throw new Error("GitHub skill source is missing owner or repo.");
  }
  const identity = sourceIdentityForGithubSkillRoot(
    {
      identity: skill.source,
      displayName: sourceText(skill),
    },
    skillPath,
  );
  return {
    identity,
    displayName: sourceText(skill),
    rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${skillPath ? `${skillPath}/` : ""}SKILL.md`,
  };
}

async function materializeGithubUpdateSource(
  paths: SkillsManagerPaths,
  skill: ManagedSkillEntry,
  resolvedSource: ResolvedSkillSource,
): Promise<MaterializedRemoteSource | undefined> {
  if (resolvedSource.identity.type !== "github") {
    return;
  }
  let githubTreeSnapshot: GithubRepoTreeSnapshot | undefined;
  const sourceRoot = await materializeResolvedSkillSource(
    resolvedSource,
    paths,
    fetch,
    {
      requestedSkillName: skill.id,
      exactSubpath: !!resolvedSource.identity.subpath,
      skipSkillsShSnapshots: true,
      onGithubTreeResolved: (snapshot) => {
        githubTreeSnapshot = snapshot;
      },
    },
  );
  return { sourceRoot, githubTreeSnapshot };
}

async function checkLegacyGithubUpdate(
  paths: SkillsManagerPaths,
  skill: ManagedSkillEntry,
  resolvedSource: ResolvedSkillSource,
  githubSkillNameCache: Map<string, string | null>,
  githubTreeCacheSession: GithubRepoTreeCacheSession,
): Promise<{ found: boolean; updateAvailable: boolean }> {
  const sourceRoot = await materializeResolvedSkillSource(
    resolvedSource,
    paths,
    fetch,
    {
      requestedSkillName: skill.id,
      exactSubpath: !!resolvedSource.identity.subpath,
      skipSkillsShSnapshots: true,
      githubSkillNameCache,
      githubTreeCacheSession,
    },
  );
  const latest = listSkillsInSource(sourceRoot).find(
    (listed) => listed.id === skill.id,
  );
  return {
    found: !!latest,
    updateAvailable:
      !!latest && latest.hash !== computeSkillFilesHash(skill.files),
  };
}

async function checkGithubUpdateGroup(
  paths: SkillsManagerPaths,
  skills: ManagedSkillEntry[],
  updates: PendingSkillUpdate[],
  sourceHeals: PendingSkillSourceHeal[],
  failures: PendingSkillUpdateFailure[],
  githubSkillNameCache: Map<string, string | null>,
  githubTreeCacheSession: GithubRepoTreeCacheSession,
  suppressFailures: boolean,
): Promise<void> {
  const first = skills[0];
  if (!(first?.source.owner && first.source.repo)) {
    return;
  }
  const { owner, repo, ref = "HEAD" } = first.source;
  let tree: Awaited<ReturnType<typeof fetchGithubRepoTreeSnapshot>>["tree"];
  let staleTree = false;
  try {
    const snapshot = await fetchGithubRepoTreeSnapshot(
      paths,
      owner,
      repo,
      ref,
      fetch,
      githubTreeCacheSession,
    );
    tree = snapshot.tree;
    staleTree = snapshot.stale;
  } catch {
    for (const skill of skills) {
      const source = sourceText(skill);
      const resolvedSource = resolvedSourceForSkill(skill);
      try {
        const legacyStatus = await checkLegacyGithubUpdate(
          paths,
          skill,
          resolvedSource,
          githubSkillNameCache,
          githubTreeCacheSession,
        );
        if (legacyStatus.updateAvailable) {
          updates.push({ skill, source, resolvedSource });
        }
      } catch (error) {
        if (!suppressFailures) {
          failures.push({
            skill,
            source,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return;
  }

  for (const skill of skills) {
    const source = sourceText(skill);
    try {
      const roots = githubSkillRootsFromTree(tree);
      const storedSkillPath =
        skill.skillPath ?? (skill.source.subpath || undefined);
      const broadGithubSource = storedSkillPath === undefined;
      const resolvedPath =
        storedSkillPath ??
        (await resolveGithubSkillPathFromTree(
          fetch,
          owner,
          repo,
          ref,
          tree,
          skill.id,
          roots,
          githubSkillNameCache,
        ));
      if (resolvedPath === null) {
        if (broadGithubSource && roots.length === 0) {
          throw new Error(
            `Deleted GitHub skill source: ${source} contains no skills.`,
          );
        }
        if (broadGithubSource && roots.length === 1) {
          continue;
        }
        throw new Error(
          `Unable to resolve ${skill.id} to one exact GitHub skill source.`,
        );
      }
      if (!roots.includes(resolvedPath)) {
        throw new Error(`Deleted GitHub skill path: ${resolvedPath}.`);
      }
      const latestFolderHash = githubSkillFolderHash(tree, resolvedPath);
      const resolvedSource = exactGithubResolvedSource(skill, resolvedPath);
      const exactSource = sourceIdentityForGithubSkillRoot(
        resolvedSource,
        resolvedPath,
      );
      const metadata: GithubSkillMetadata = {
        remoteSlug: `${owner}/${repo}`,
        skillPath: resolvedPath,
        ...(staleTree
          ? {}
          : { skillFolderHash: latestFolderHash ?? undefined }),
      };
      const hasCurrentFolderHash =
        !!skill.skillFolderHash && latestFolderHash !== null && !staleTree;
      const legacyStatus = hasCurrentFolderHash
        ? {
            found: true,
            updateAvailable: latestFolderHash !== skill.skillFolderHash,
          }
        : await checkLegacyGithubUpdate(
            paths,
            skill,
            resolvedSource,
            githubSkillNameCache,
            githubTreeCacheSession,
          );
      if (broadGithubSource && !legacyStatus.found) {
        continue;
      }
      const shouldHealExactLegacy = !(hasCurrentFolderHash || staleTree);
      const needsHeal = broadGithubSource
        ? resolvedPath !== ""
        : shouldHealExactLegacy;
      if (needsHeal && !legacyStatus.updateAvailable) {
        sourceHeals.push({ skill, source: exactSource, metadata });
      }
      if (legacyStatus.updateAvailable) {
        updates.push({ skill, source, resolvedSource });
      }
    } catch (error) {
      if (!suppressFailures) {
        failures.push({
          skill,
          source,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export async function findRemoteUpdates(
  options: {
    paths?: SkillsManagerPaths;
    manifest?: ManagedSkillsManifest;
    suppressFailures?: boolean;
    onProgress?: (index: number, total: number, source: string) => void;
  } = {},
): Promise<RemoteUpdateCheckResult> {
  const paths = options.paths ?? createSkillsManagerPaths();
  const manifest = options.manifest ?? readManagedManifest(paths.manifestPath);
  const updates: PendingSkillUpdate[] = [];
  const sourceHeals: PendingSkillSourceHeal[] = [];
  const failures: PendingSkillUpdateFailure[] = [];
  const githubSkillNameCache = new Map<string, string | null>();
  const githubTreeCacheSession = createGithubRepoTreeCacheSession(paths);
  const candidates = manifest.skills.filter(
    (skill) => skill.source.type !== "directory",
  );
  const githubGroups = new Map<string, ManagedSkillEntry[]>();
  const otherCandidates: ManagedSkillEntry[] = [];
  for (const skill of candidates) {
    const groupKey = githubUpdateGroupKey(skill);
    if (groupKey) {
      githubGroups.set(groupKey, [
        ...(githubGroups.get(groupKey) ?? []),
        skill,
      ]);
    } else {
      otherCandidates.push(skill);
    }
  }
  const totalSources = githubGroups.size + otherCandidates.length;
  let sourceIndex = 0;
  for (const [source, skills] of githubGroups) {
    options.onProgress?.(++sourceIndex, totalSources, source);
    await checkGithubUpdateGroup(
      paths,
      skills,
      updates,
      sourceHeals,
      failures,
      githubSkillNameCache,
      githubTreeCacheSession,
      !!options.suppressFailures,
    );
  }
  for (const skill of otherCandidates) {
    const source = sourceText(skill);
    options.onProgress?.(++sourceIndex, totalSources, source);
    try {
      const resolvedSource = resolvedSourceForSkill(skill);
      const sourceRoot = await materializeResolvedSkillSource(
        resolvedSource,
        paths,
        fetch,
      );
      const latest = listSkillsInSource(sourceRoot).find(
        (listed) => listed.id === skill.id,
      );
      if (latest && latest.hash !== computeSkillFilesHash(skill.files)) {
        updates.push({ skill, source, resolvedSource });
      }
    } catch (error) {
      if (options.suppressFailures) {
        continue;
      }
      failures.push({
        skill,
        source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { updates, sourceHeals, failures };
}

export async function updateManaged(
  prompter: Prompter,
  options: OpsChoices = {},
): Promise<void> {
  const paths = options.paths ?? createSkillsManagerPaths();
  const manifest = readManagedManifest(paths.manifestPath);
  const { updates, sourceHeals, failures } = await findRemoteUpdates({
    paths,
    manifest,
    onProgress: (index, total, source) => {
      prompter.progress?.(`Checking sources ${index}/${total} (${source})`);
    },
  });
  const requestedIds = options.skillNames ?? [];
  const requested = requestedIds.length > 0;
  const isRequested = (skill: ManagedSkillEntry) =>
    requestedIds.includes(skill.id);
  const matchingFailures = requested
    ? failures.filter(({ skill }) => isRequested(skill))
    : [];
  if (matchingFailures.length > 0) {
    throw new Error(formatUpdateFailures(matchingFailures));
  }
  if (!requested && failures.length > 0) {
    prompter.notify(formatUpdateFailures(failures), "warning");
  }
  const matchingSourceHeals = requested
    ? sourceHeals.filter(({ skill }) => isRequested(skill))
    : sourceHeals;
  if (matchingSourceHeals.length > 0) {
    applySourceHeals(paths, matchingSourceHeals);
    prompter.notify(
      `Updated exact source metadata for ${matchingSourceHeals.length} skill(s).`,
      "info",
    );
  }
  if (updates.length === 0) {
    prompter.setUpdateCount?.(0);
    prompter.notify("No skill updates found.", "info");
    return;
  }
  let targets: PendingSkillUpdate[];
  if (requested) {
    targets = updates.filter(({ skill }) => isRequested(skill));
  } else if (options.all) {
    targets = updates;
  } else {
    const selected = await prompter.select("Update skill (All or one)", [
      "All updates",
      ...updates.map(({ skill }) => `${skill.name} (${skill.id})`),
    ]);
    if (!selected) {
      return;
    }
    targets =
      selected === "All updates"
        ? updates
        : updates.filter(({ skill }) => selected.endsWith(`(${skill.id})`));
  }
  if (targets.length === 0) {
    if (matchingSourceHeals.length === 0) {
      prompter.notify("No matching skill updates found.", "warning");
    }
    return;
  }
  const updated: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const [index, { skill, source, resolvedSource }] of targets.entries()) {
    prompter.progress?.(
      `Updating skills ${index + 1}/${targets.length}: ${skill.name}`,
    );
    try {
      const ok = await confirmCleanOverwrite(
        prompter,
        skill,
        manifest,
        options.yes,
      );
      if (!ok) {
        skipped.push(skill.name);
        continue;
      }
      const materializedSource = await materializeGithubUpdateSource(
        paths,
        skill,
        resolvedSource,
      );
      const installed = await installLocalSource(prompter, source, {
        paths,
        confirmDirty: false,
        requestedSkillName: skill.id,
        resolvedSource,
        materializedSource,
        skipSuccessNotify: true,
      });
      if (!installed?.length) {
        throw new Error("No matching skill found in source.");
      }
      updated.push(...installed.map((entry) => entry.name));
    } catch (error) {
      failed.push(
        `${skill.name} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  prompter.setUpdateCount?.(updates.length - updated.length);
  const updatedNames = updated.length ? `: ${updated.join(", ")}` : "";
  const summary = [
    `Updated ${updated.length}/${targets.length} skills${updatedNames}.`,
  ];
  if (failed.length > 0) {
    summary.push(`Failed: ${failed.join(", ")}.`);
  }
  if (skipped.length > 0) {
    summary.push(`Skipped: ${skipped.join(", ")}.`);
  }
  summary.push(RELOAD_MESSAGE);
  prompter.notify(summary.join(" "), failed.length ? "warning" : "info");
}

function trashPath(targetPath: string): void {
  const result = spawnSync("trash", [targetPath], { stdio: "ignore" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error("trash command failed.");
  }
}

export async function removeManaged(
  prompter: Prompter,
  options: OpsChoices = {},
): Promise<void> {
  const paths = options.paths ?? createSkillsManagerPaths();
  const manifest = readManagedManifest(paths.manifestPath);
  const id =
    options.skillNames?.[0] ||
    (await prompter
      .select(
        "Remove skill",
        manifest.skills.map((entry) => `${entry.name} (${entry.id})`),
      )
      .then((selected) => selected?.match(SELECTED_ID_RE)?.[1] ?? ""));
  if (!id) {
    return;
  }
  const skill = manifest.skills.find((entry) => entry.id === id);
  const dirty = detectDirtySkills(manifest).find((entry) => entry.id === id);
  const ok =
    options.yes ||
    (await prompter.confirm(
      dirty ? "Remove dirty skill" : "Remove skill",
      dirty && skill
        ? `Remove managed skill ${id}? ${dirtyWarning(skill, dirty.changedFiles)}`
        : `Remove managed skill ${id}?`,
    ));
  if (!ok) {
    return;
  }
  withSkillsWriteLock(paths, () => {
    const nextManifest = readManagedManifest(paths.manifestPath);
    const plan = planRemoveSkill(id, nextManifest);
    applyRemovePlan(plan, paths, trashPath);
  });
  prompter.notify(`Removed ${id}. ${RELOAD_MESSAGE}`, "info");
}

/** Cache-first skills.sh search; refreshes the cache on a miss. */
export async function findSkills(
  query: string,
  paths: SkillsManagerPaths = createSkillsManagerPaths(),
): Promise<RemoteSkillMetadata[]> {
  let cache = readSkillsSearchCache(paths.cachePath);
  let results = searchCachedSkills(cache, query);
  if (results.length === 0) {
    cache = await fetchSkillsShSearchCache(query);
    writeSkillsSearchCache(paths.cachePath, cache);
    results = searchCachedSkills(cache, query);
  }
  return results;
}

export async function searchSkills(
  prompter: Prompter,
  queryArg: string,
  options: OpsChoices = {},
): Promise<void> {
  const paths = options.paths ?? createSkillsManagerPaths();
  const query =
    queryArg ||
    (await prompter.input("Search skills", "query or direct local source"));
  if (!query) {
    return;
  }
  if (isDirectSourceQuery(query)) {
    const install =
      options.yes ||
      (await prompter.confirm("Install source", `Install from ${query}?`));
    if (install) {
      await installLocalSource(prompter, query, options);
    }
    return;
  }
  const results = await findSkills(query, paths);
  if (results.length === 0) {
    prompter.notify("No skills found.", "info");
    return;
  }
  const selected = await prompter.select(
    `Install skill (${results.length} found)`,
    ["Cancel", ...results.map(remoteSkillLabel)],
  );
  if (!selected || selected === "Cancel") {
    return;
  }
  const skill = results.find((result) => selected === remoteSkillLabel(result));
  const source = skill ? remoteSkillSource(skill) : "";
  if (source) {
    await installLocalSource(prompter, source, {
      paths,
      yes: options.yes,
      requestedSkillName: skill?.skillName ?? skill?.name,
    });
  }
}
