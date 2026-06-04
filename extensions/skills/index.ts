import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import {
  createSkillOperationActivity,
  type SkillOperationActivity,
} from "./activity";
import {
  applyRemovePlan,
  computeSkillFilesHash,
  copyInstallPlan,
  createSkillsManagerPaths,
  detectDirtySkills,
  discoverBundledSkillPaths,
  fetchSkillsShSearchCache,
  findListedSkillSourceDir,
  installSelectedSkillsSequentially,
  type ListedSkillSource,
  listSkillsInSource,
  type ManagedSkillEntry,
  materializeResolvedSkillSource,
  parseSkillSource,
  planInstallSkill,
  planRemoveSkill,
  type RemoteSkillMetadata,
  type ResolvedSkillSource,
  readManagedManifest,
  readSkillsSearchCache,
  type SkillSourceIdentity,
  searchCachedSkills,
  sourceIdentityForGithubSkillRoot,
  withSkillsWriteLock,
  writeManagedManifest,
  writeSkillsSearchCache,
} from "./core";
import {
  buildSkillInventoryModel,
  parseSkillCommandInitialState,
  type SkillInventoryModel,
} from "./model";
import {
  createSkillsInstallPickerComponent,
  createSkillsManagerComponent,
} from "./ui";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = join(EXTENSION_DIR, "..", "..", "skills");
const STATUS_KEY = "skills";
const RELOAD_MESSAGE = "Changes apply after /reload or next session.";
const SELECTED_ID_RE = /\(([^)]+)\)$/;
const WHITESPACE_RE = /\s+/;
const TRAILING_ZERO_DECIMAL_RE = /\.0$/;
const TRAILING_SLASH_RE = /\/$/;
const BACKSLASH_RE = /\\/g;

function withSkillOperationPromptsSuspended(
  ctx: ExtensionCommandContext,
  activity: SkillOperationActivity,
  label: string
): ExtensionCommandContext {
  const resumeAfterPrompt = (): void => {
    activity.start(label);
  };
  const suspend = (): void => {
    activity.suspendBeforePrompt();
  };
  const ui = {
    ...ctx.ui,
    async select(...args: Parameters<typeof ctx.ui.select>) {
      suspend();
      const result = await ctx.ui.select(...args);
      resumeAfterPrompt();
      return result;
    },
    async confirm(...args: Parameters<typeof ctx.ui.confirm>) {
      suspend();
      const result = await ctx.ui.confirm(...args);
      resumeAfterPrompt();
      return result;
    },
    async input(...args: Parameters<typeof ctx.ui.input>) {
      suspend();
      const result = await ctx.ui.input(...args);
      resumeAfterPrompt();
      return result;
    },
    notify(...args: Parameters<typeof ctx.ui.notify>) {
      suspend();
      ctx.ui.notify(...args);
    },
  };
  if (typeof ctx.ui.custom === "function") {
    const custom = ctx.ui.custom;
    ui.custom = (async (...args: Parameters<typeof custom>) => {
      suspend();
      const result = await custom(...args);
      resumeAfterPrompt();
      return result;
    }) as typeof custom;
  }
  return { ...ctx, ui } as ExtensionCommandContext;
}

export function skillOperationLabel(
  subcommand: string,
  enteredSubcommand = subcommand
): string {
  switch (subcommand) {
    case "search":
      return "Searching skills…";
    case "install":
      return "Installing skill…";
    case "update":
      return "Updating skills…";
    case "remove":
      return "Removing skill…";
    case "list":
      return "Loading skills…";
    default:
      return `Running skill ${enteredSubcommand}…`;
  }
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
        subpath
      ),
      displayName: source,
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${subpath ? `${subpath}/` : ""}SKILL.md`,
    };
  }
  return parseSkillSource(source);
}

const COMMANDS: AutocompleteItem[] = [
  {
    value: "list",
    label: "list",
    description: "List installed and bundled skills",
  },
  {
    value: "search",
    label: "search",
    description: "Search skills.sh cache or web",
  },
  {
    value: "install ",
    label: "install",
    description: "Install from a local skill directory",
  },
  {
    value: "update",
    label: "update",
    description: "Update remote managed skills",
  },
  { value: "remove ", label: "remove", description: "Remove a managed skill" },
];

function notifyError(ctx: ExtensionCommandContext, error: unknown): void {
  ctx.ui.notify(
    error instanceof Error ? error.message : String(error),
    "error"
  );
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

function remoteSkillLabel(skill: RemoteSkillMetadata): string {
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

function formatList(managed: ManagedSkillEntry[]): string {
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

async function showSkillsManager(
  ctx: ExtensionCommandContext,
  managed: ManagedSkillEntry[],
  initialQuery = ""
): Promise<void> {
  const dirty = detectDirtySkills({ version: 1, skills: managed });
  const dirtyIds = new Set(dirty.map((skill) => skill.id));
  const inventory = buildSkillInventoryModel({
    managed,
    bundledSkillPaths: discoverBundledSkillPaths(BUNDLED_SKILLS_DIR),
    dirtyIds,
  });
  const fallbackText = formatList(managed);
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
    ctx.ui.notify(fallbackText, "info");
    return;
  }
  await ctx.ui.custom<void>(
    (_tui, theme, _kb, done) =>
      createSkillsManagerComponent({
        inventory,
        initialQuery,
        theme,
        done: () => done(undefined),
      }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "90%",
        minWidth: 64,
        maxHeight: "95%",
        margin: 1,
      },
    }
  );
}

function dirtyWarning(
  skill: ManagedSkillEntry,
  changedFiles: string[]
): string {
  const files = changedFiles.slice(0, 5).join(", ");
  const suffix =
    changedFiles.length > 5 ? `, +${changedFiles.length - 5} more` : "";
  return `${skill.name} has local changes or missing managed files (${files}${suffix}). Continue?`;
}

function confirmCleanOverwrite(
  ctx: ExtensionCommandContext,
  skill: ManagedSkillEntry,
  manifest = readManagedManifest(createSkillsManagerPaths().manifestPath)
): Promise<boolean> {
  const dirty = detectDirtySkills(manifest).find(
    (entry) => entry.id === skill.id
  );
  if (!dirty) {
    return Promise.resolve(true);
  }
  return ctx.ui.confirm(
    "Overwrite dirty skill",
    dirtyWarning(skill, dirty.changedFiles)
  );
}

async function selectSkillSourceDir(
  ctx: ExtensionCommandContext,
  entries: ListedSkillSource[]
): Promise<string | undefined> {
  if (entries.length === 1) {
    return entries[0]?.sourceDir;
  }
  const selected = await ctx.ui.select(
    "Install skill",
    entries.map((listed) => `${listed.name} — ${listed.sourceDir}`)
  );
  return entries.find((listed) => selected?.endsWith(listed.sourceDir))
    ?.sourceDir;
}

function installPickerInventory(
  entries: ListedSkillSource[],
  managed: ManagedSkillEntry[],
  dirtyIds: ReadonlySet<string>
): SkillInventoryModel {
  const managedById = new Map(managed.map((skill) => [skill.id, skill]));
  const items = entries.map((entry) => {
    const installed = managedById.get(entry.id);
    let dirtyStatus: "dirty" | "clean" | undefined;
    if (installed) {
      dirtyStatus = dirtyIds.has(installed.id) ? "dirty" : "clean";
    }
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      kind: installed ? ("managed" as const) : ("bundled" as const),
      path: entry.sourceDir,
      displayPath: entry.sourceDir,
      source: installed?.source,
      dirtyStatus,
    };
  });
  return {
    managed: items.filter((item) => item.kind === "managed"),
    bundled: items.filter((item) => item.kind === "bundled"),
    all: items,
  };
}

async function selectSkillSourceDirs(
  ctx: ExtensionCommandContext,
  entries: ListedSkillSource[],
  source: string,
  sourceRoot: string,
  manifest = readManagedManifest(createSkillsManagerPaths().manifestPath)
): Promise<string[] | undefined> {
  if (entries.length === 1) {
    return entries[0] ? [entries[0].sourceDir] : [];
  }
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
    const first = entries[0];
    const suggestion = first
      ? `${source.replace(TRAILING_SLASH_RE, "")}/tree/${parseSkillSource(source).identity.ref ?? "HEAD"}/${relative(sourceRoot, first.sourceDir).replace(BACKSLASH_RE, "/")}`
      : source;
    ctx.ui.notify(
      `Multiple skills found. Run /skill install ${suggestion} to install one skill.`,
      "warning"
    );
    return undefined;
  }
  const selectedIds = await ctx.ui.custom<string[] | undefined>(
    (_tui, theme, _kb, done) =>
      createSkillsInstallPickerComponent({
        inventory: installPickerInventory(
          entries,
          manifest.skills,
          new Set(detectDirtySkills(manifest).map((skill) => skill.id))
        ),
        theme,
        done,
      }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "90%",
        minWidth: 64,
        maxHeight: "95%",
        margin: 1,
      },
    }
  );
  if (!selectedIds) {
    return undefined;
  }
  if (selectedIds.length === 0) {
    ctx.ui.notify("Select at least one skill to install.", "warning");
    return undefined;
  }
  const selected = new Set(selectedIds);
  return entries
    .filter((entry) => selected.has(entry.id))
    .map((entry) => entry.sourceDir);
}

function remoteIdentityForEntry(
  source: string,
  sourceRoot: string,
  entry: ListedSkillSource
) {
  const resolved = parseSkillSource(source);
  if (resolved.identity.type !== "github") {
    return resolved.identity;
  }
  const relativeEntry = relative(sourceRoot, entry.sourceDir).replace(
    BACKSLASH_RE,
    "/"
  );
  const subpath = [resolved.identity.subpath, relativeEntry]
    .filter(Boolean)
    .join("/");
  return parseSkillSource(
    `${resolved.identity.owner}/${resolved.identity.repo}/tree/${resolved.identity.ref ?? "HEAD"}/${subpath}`
  ).identity;
}

function formatInstalledMessage(installed: { name: string }[]): string {
  const names = installed.map((entry) => entry.name).join(", ");
  return `Installed ${installed.length} skill${installed.length === 1 ? "" : "s"}: ${names}. ${RELOAD_MESSAGE}`;
}

function exactGithubSourceResolutionError(
  requestedSkillName: string | undefined,
  source: string
): Error {
  return new Error(
    `Unable to resolve ${requestedSkillName} to one exact GitHub skill source from ${source}.`
  );
}

async function installLocalSource(
  ctx: ExtensionCommandContext,
  source: string,
  confirmDirty = true,
  requestedSkillName?: string,
  resolvedSource?: ResolvedSkillSource
): Promise<void> {
  const paths = createSkillsManagerPaths();
  const resolved = resolvedSource ?? parseSkillSource(source);
  let exactSourceIdentity: SkillSourceIdentity | undefined;
  const shouldResolveExactSource =
    !resolved.localPath &&
    resolved.identity.type === "github" &&
    !resolved.identity.subpath &&
    !!requestedSkillName;
  const sourceRoot =
    resolved.localPath ??
    (await materializeResolvedSkillSource(resolved, paths, fetch, {
      requestedSkillName,
      onExactSourceResolved: (identity) => {
        exactSourceIdentity = identity;
      },
    }));
  if (shouldResolveExactSource && !exactSourceIdentity) {
    throw exactGithubSourceResolutionError(requestedSkillName, source);
  }
  const entries = listSkillsInSource(sourceRoot);
  if (entries.length === 0) {
    ctx.ui.notify("No SKILL.md files found in source.", "warning");
    return;
  }
  const isRepoShorthand =
    !resolved.localPath &&
    resolved.identity.type === "github" &&
    !resolved.identity.subpath &&
    !source.startsWith("http") &&
    !requestedSkillName;
  if (isRepoShorthand) {
    const selectedSourceDirs = await selectSkillSourceDirs(
      ctx,
      entries,
      source,
      sourceRoot
    );
    if (!selectedSourceDirs || selectedSourceDirs.length === 0) {
      return;
    }
    if (confirmDirty) {
      const currentManifest = readManagedManifest(paths.manifestPath);
      for (const sourceDir of selectedSourceDirs) {
        const plan = planInstallSkill(sourceDir, paths, currentManifest);
        const existing = currentManifest.skills.find(
          (skill) => skill.id === plan.id
        );
        if (existing) {
          const ok = await confirmCleanOverwrite(
            ctx,
            existing,
            currentManifest
          );
          if (!ok) {
            return;
          }
        }
      }
    }
    const result = withSkillsWriteLock(paths, () =>
      installSelectedSkillsSequentially(
        entries,
        selectedSourceDirs,
        paths,
        (entry) => remoteIdentityForEntry(source, sourceRoot, entry)
      )
    );
    if (result.failed) {
      throw new Error(
        `Failed to install ${result.failed.sourceDir}: ${
          result.failed.error instanceof Error
            ? result.failed.error.message
            : String(result.failed.error)
        }`
      );
    }
    ctx.ui.notify(formatInstalledMessage(result.installed), "info");
    return;
  }
  const choice = requestedSkillName
    ? findListedSkillSourceDir(entries, requestedSkillName)
    : await selectSkillSourceDir(ctx, entries);
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
    const ok = await confirmCleanOverwrite(ctx, existing, currentManifest);
    if (!ok) {
      return;
    }
  }
  const installed = withSkillsWriteLock(paths, () => {
    const entry = copyInstallPlan(plan, paths);
    if (!resolved.localPath) {
      const manifest = readManagedManifest(paths.manifestPath);
      const next = {
        version: manifest.version,
        skills: manifest.skills.map((skill) =>
          skill.id === entry.id
            ? { ...entry, source: exactSourceIdentity ?? resolved.identity }
            : skill
        ),
      };
      writeManagedManifest(paths.manifestPath, next);
      return next.skills.find((skill) => skill.id === entry.id) ?? entry;
    }
    return entry;
  });
  ctx.ui.notify(formatInstalledMessage([installed]), "info");
}

interface PendingSkillUpdate {
  skill: ManagedSkillEntry;
  source: string;
  resolvedSource: ResolvedSkillSource;
}

interface PendingSkillSourceHeal {
  skill: ManagedSkillEntry;
  source: SkillSourceIdentity;
}

interface PendingSkillUpdateFailure {
  skill: ManagedSkillEntry;
  source: string;
  message: string;
}

interface RemoteUpdateCheckResult {
  updates: PendingSkillUpdate[];
  sourceHeals: PendingSkillSourceHeal[];
  failures: PendingSkillUpdateFailure[];
}

function formatUpdateFailures(failures: PendingSkillUpdateFailure[]): string {
  const suffix = failures.length === 1 ? "" : "s";
  return `Unable to check ${failures.length} skill update source${suffix}: ${failures
    .map(
      ({ skill, source, message }) => `${skill.name} (${source}): ${message}`
    )
    .join("; ")}`;
}

function applySourceHeals(
  paths: ReturnType<typeof createSkillsManagerPaths>,
  sourceHeals: PendingSkillSourceHeal[]
): void {
  withSkillsWriteLock(paths, () => {
    const latestManifest = readManagedManifest(paths.manifestPath);
    writeManagedManifest(paths.manifestPath, {
      version: latestManifest.version,
      skills: latestManifest.skills.map((entry) => {
        const heal = sourceHeals.find(({ skill }) => skill.id === entry.id);
        return heal ? { ...entry, source: heal.source } : entry;
      }),
    });
  });
}

async function findRemoteUpdates(
  manifest = readManagedManifest(createSkillsManagerPaths().manifestPath),
  options: { suppressFailures?: boolean } = {}
): Promise<RemoteUpdateCheckResult> {
  const paths = createSkillsManagerPaths();
  const updates: PendingSkillUpdate[] = [];
  const sourceHeals: PendingSkillSourceHeal[] = [];
  const failures: PendingSkillUpdateFailure[] = [];
  const githubSkillNameCache = new Map<string, string | null>();
  const candidates = manifest.skills.filter(
    (skill) => skill.source.type !== "directory"
  );
  for (const skill of candidates) {
    const source = sourceText(skill);
    try {
      const exactSubpath = !!skill.source.subpath;
      const broadGithubSource =
        skill.source.type === "github" && !skill.source.subpath;
      let exactSourceIdentity: SkillSourceIdentity | undefined;
      const resolvedSource = resolvedSourceForSkill(skill);
      const sourceRoot = await materializeResolvedSkillSource(
        resolvedSource,
        paths,
        fetch,
        {
          requestedSkillName: exactSubpath ? undefined : skill.id,
          exactSubpath,
          onExactSourceResolved: (identity) => {
            exactSourceIdentity = identity;
          },
          githubSkillNameCache,
        }
      );
      if (broadGithubSource && !exactSourceIdentity) {
        throw new Error(
          `Unable to resolve ${skill.id} to one exact GitHub skill source.`
        );
      }
      const latest = listSkillsInSource(sourceRoot).find(
        (listed) => listed.id === skill.id
      );
      if (
        broadGithubSource &&
        exactSourceIdentity &&
        latest &&
        exactSourceIdentity.id !== skill.source.id
      ) {
        sourceHeals.push({ skill, source: exactSourceIdentity });
      }
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

async function updateManaged(
  ctx: ExtensionCommandContext,
  idArgs = ""
): Promise<void> {
  const paths = createSkillsManagerPaths();
  const manifest = readManagedManifest(paths.manifestPath);
  const { updates, sourceHeals, failures } = await findRemoteUpdates(manifest);
  const requestedId = idArgs.split(WHITESPACE_RE).filter(Boolean)[0];
  const matchingFailures = requestedId
    ? failures.filter(({ skill }) => skill.id === requestedId)
    : [];
  if (matchingFailures.length > 0) {
    throw new Error(formatUpdateFailures(matchingFailures));
  }
  if (failures.length > 0) {
    ctx.ui.notify(formatUpdateFailures(failures), "warning");
  }
  const matchingSourceHeals = requestedId
    ? sourceHeals.filter(({ skill }) => skill.id === requestedId)
    : sourceHeals;
  if (matchingSourceHeals.length > 0) {
    applySourceHeals(paths, matchingSourceHeals);
    ctx.ui.notify(
      `Updated exact source metadata for ${matchingSourceHeals.length} skill(s).`,
      "info"
    );
  }
  if (updates.length === 0) {
    refreshStatus(ctx);
    ctx.ui.notify("No skill updates found.", "info");
    return;
  }
  let targets: PendingSkillUpdate[];
  if (requestedId) {
    targets = updates.filter(({ skill }) => skill.id === requestedId);
  } else {
    const selected = await ctx.ui.select("Update skill (All or one)", [
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
      ctx.ui.notify("No matching skill updates found.", "warning");
    }
    return;
  }
  let updatedCount = 0;
  for (const { skill, source, resolvedSource } of targets) {
    const ok = await confirmCleanOverwrite(ctx, skill, manifest);
    if (ok) {
      await installLocalSource(ctx, source, false, skill.id, resolvedSource);
      updatedCount += 1;
    }
  }
  refreshStatus(ctx, updates.length - updatedCount);
  ctx.ui.notify(`Updated ${updatedCount} skill(s). ${RELOAD_MESSAGE}`, "info");
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

async function removeManaged(
  ctx: ExtensionCommandContext,
  idArg: string
): Promise<void> {
  const paths = createSkillsManagerPaths();
  const manifest = readManagedManifest(paths.manifestPath);
  const id =
    idArg ||
    (await ctx.ui
      .select(
        "Remove skill",
        manifest.skills.map((entry) => `${entry.name} (${entry.id})`)
      )
      .then((selected) => selected?.match(SELECTED_ID_RE)?.[1] ?? ""));
  if (!id) {
    return;
  }
  const skill = manifest.skills.find((entry) => entry.id === id);
  const dirty = detectDirtySkills(manifest).find((entry) => entry.id === id);
  const ok = await ctx.ui.confirm(
    dirty ? "Remove dirty skill" : "Remove skill",
    dirty && skill
      ? `Remove managed skill ${id}? ${dirtyWarning(skill, dirty.changedFiles)}`
      : `Remove managed skill ${id}?`
  );
  if (!ok) {
    return;
  }
  withSkillsWriteLock(paths, () => {
    const nextManifest = readManagedManifest(paths.manifestPath);
    const plan = planRemoveSkill(id, nextManifest);
    applyRemovePlan(plan, paths, trashPath);
  });
  ctx.ui.notify(`Removed ${id}. ${RELOAD_MESSAGE}`, "info");
}

async function searchSkills(
  ctx: ExtensionCommandContext,
  queryArg: string
): Promise<void> {
  const paths = createSkillsManagerPaths();
  const query =
    queryArg ||
    (await ctx.ui.input("Search skills", "query or direct local source"));
  if (!query) {
    return;
  }
  if (isDirectSourceQuery(query)) {
    const install = await ctx.ui.confirm(
      "Install source",
      `Install from ${query}?`
    );
    if (install) {
      await installLocalSource(ctx, query);
    }
    return;
  }
  let cache = readSkillsSearchCache(paths.cachePath);
  let results = searchCachedSkills(cache, query);
  if (results.length === 0) {
    cache = await fetchSkillsShSearchCache(query);
    writeSkillsSearchCache(paths.cachePath, cache);
    results = searchCachedSkills(cache, query);
  }
  if (results.length === 0) {
    ctx.ui.notify("No skills found.", "info");
    return;
  }
  const selected = await ctx.ui.select(
    `Install skill (${results.length} found)`,
    ["Cancel", ...results.map(remoteSkillLabel)]
  );
  if (!selected || selected === "Cancel") {
    return;
  }
  const skill = results.find((result) => selected === remoteSkillLabel(result));
  const source = skill ? remoteSkillSource(skill) : "";
  if (source) {
    await installLocalSource(
      ctx,
      source,
      true,
      skill?.skillName ?? skill?.name
    );
  }
}

function updateStatusText(updateCount: number): string | undefined {
  if (updateCount === 0) {
    return undefined;
  }
  const suffix = updateCount === 1 ? "" : "s";
  return `Skills: ${updateCount} update${suffix}`;
}

function refreshStatus(ctx: ExtensionCommandContext, updateCount = 0): void {
  ctx.ui.setStatus(STATUS_KEY, updateStatusText(updateCount));
}

async function checkRemoteUpdatesInBackground(
  ctx: ExtensionCommandContext
): Promise<void> {
  try {
    const { updates } = await findRemoteUpdates(undefined, {
      suppressFailures: true,
    });
    refreshStatus(ctx, updates.length);
    if (updates.length > 0) {
      ctx.ui.notify(
        `${updates.length} managed skill update${updates.length === 1 ? "" : "s"} available. Run /skill update.`,
        "info"
      );
    }
  } catch {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

export default function skillsExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({
    skillPaths: [
      ...discoverBundledSkillPaths(BUNDLED_SKILLS_DIR),
      ...readManagedManifest(
        createSkillsManagerPaths().manifestPath
      ).skills.flatMap((skill) => discoverBundledSkillPaths(skill.installPath)),
    ],
  }));

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }
    queueMicrotask(() => {
      try {
        checkRemoteUpdatesInBackground(ctx as ExtensionCommandContext).catch(
          () => {
            ctx.ui.setStatus(STATUS_KEY, undefined);
          }
        );
      } catch {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    });
  });

  pi.registerCommand("skill", {
    description: "/skill list|search|install|update|remove",
    getArgumentCompletions(argumentPrefix) {
      const trimmed = argumentPrefix.trimStart();
      return COMMANDS.filter((item) => item.value.startsWith(trimmed));
    },
    async handler(args, ctx) {
      const parsed = parseSkillCommandInitialState(args ?? "");
      const subcommand = parsed.action;
      const operand = parsed.operand;
      const activity = createSkillOperationActivity(ctx);
      const label = skillOperationLabel(subcommand, parsed.enteredSubcommand);
      const activityCtx = withSkillOperationPromptsSuspended(
        ctx,
        activity,
        label
      );
      activity.start(label);
      try {
        switch (subcommand) {
          case "list":
            await showSkillsManager(
              activityCtx,
              readManagedManifest(createSkillsManagerPaths().manifestPath)
                .skills,
              operand
            );
            break;
          case "search":
            await searchSkills(activityCtx, operand);
            break;
          case "install":
            await installLocalSource(
              activityCtx,
              operand ||
                (await activityCtx.ui.input(
                  "Install skill",
                  "local skill directory"
                )) ||
                ""
            );
            break;
          case "update":
            await updateManaged(activityCtx, operand);
            break;
          case "remove":
            await removeManaged(activityCtx, operand);
            break;
          default:
            activity.suspendBeforePrompt();
            ctx.ui.notify(
              "Usage: /skill list|search|install|update|remove",
              "warning"
            );
        }
        activity.finishSuccess();
      } catch (error) {
        activity.finishFailure();
        notifyError(ctx, error);
      }
    },
  });
}
