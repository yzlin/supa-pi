import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const SKILL_FILE_NAME = "SKILL.md";
export const MANIFEST_VERSION = 1;
export const SEARCH_CACHE_VERSION = 5;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const H1_RE = /^#\s+(.+)$/m;
const NAME_RE = /^name:\s*(.+)$/im;
const DESCRIPTION_RE = /^description:\s*(.+)$/im;
const DESCRIPTION_SECTION_RE = /^##\s+Description\s*\n+([^#\n].*)$/im;
const FENCE_START_RE = /^\s*(```|~~~)/;
const LINE_BREAK_RE = /\r?\n/;
const GITHUB_SOURCE_RE =
  /^(?:https:\/\/github\.com\/|git@github\.com:)?([^/\s:]+)\/([^/\s:#]+)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)\/(.*))?(?:#(.+))?$/;
const GIT_SUFFIX_RE = /\.git$/;
const HTTP_URL_RE = /^https?:\/\//;
const PLAIN_HTTP_URL_RE = /^http:\/\//;
const TRAILING_SLASH_RE = /\/$/;
const WHITESPACE_RE = /\s+/;
const ALPHANUMERIC_RE = /[a-z0-9]/;
const HTML_HREF_RE = /href=["']([^"']+)["']/gi;
const SLASH_RE = /\//;

export type SkillSourceKind = "directory" | "github" | "repo" | "skills.sh";
type SkillFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface SkillSourceIdentity {
  type: SkillSourceKind;
  path: string;
  id: string;
  ref?: string;
  subpath?: string;
  owner?: string;
  repo?: string;
  url?: string;
}

export interface ResolvedSkillSource {
  identity: SkillSourceIdentity;
  displayName: string;
  localPath?: string;
  rawUrl?: string;
}

export interface RemoteSkillMetadata {
  name: string;
  description: string;
  source: string;
  skillName?: string;
  installs?: number;
  url?: string;
  repository?: string;
  updatedAt?: string;
}

export interface SkillsSearchCache {
  version: typeof SEARCH_CACHE_VERSION;
  fetchedAt: string;
  query?: string;
  skills: RemoteSkillMetadata[];
}

export interface ListedSkillSource {
  id: string;
  name: string;
  description: string;
  sourceDir: string;
  identity: SkillSourceIdentity;
  hash: string;
}

interface GitHubTreeItem {
  path?: string;
  type?: string;
  sha?: string;
}

interface GitHubBlobItem extends GitHubTreeItem {
  path: string;
  type: "blob";
}

export interface MaterializeResolvedSkillSourceOptions {
  requestedSkillName?: string;
  exactSubpath?: boolean;
  onExactSourceResolved?: (identity: SkillSourceIdentity) => void;
  githubSkillNameCache?: Map<string, string | null>;
}

export interface SkillUpdateStatus {
  id: string;
  installedHash: string;
  latestHash: string | null;
  updateAvailable: boolean;
  remoteManaged: boolean;
  reason?: string;
}

export interface ManagedSkillFile {
  relativePath: string;
  sha256: string;
  bytes: number;
}

export interface ManagedSkillEntry {
  id: string;
  name: string;
  description: string;
  source: SkillSourceIdentity;
  installPath: string;
  installedAt: string;
  files: ManagedSkillFile[];
}

export interface ManagedSkillsManifest {
  version: typeof MANIFEST_VERSION;
  skills: ManagedSkillEntry[];
}

export interface SkillsManagerPaths {
  rootDir: string;
  managedDir: string;
  cacheDir: string;
  cachePath: string;
  manifestPath: string;
  lockPath: string;
}

export interface SkillValidationResult {
  ok: boolean;
  name: string | null;
  description: string | null;
  errors: string[];
}

export interface InstallPlan {
  id: string;
  sourceDir: string;
  targetDir: string;
  files: ManagedSkillFile[];
  validation: SkillValidationResult;
  action: "install" | "replace";
  existingId?: string;
  existingInstallPath?: string;
}

export interface RemovePlan {
  id: string;
  installPath: string;
  trashBoundary: "trash-cli";
  exists: boolean;
}

export interface DirtySkill {
  id: string;
  status: "missing" | "dirty";
  changedFiles: string[];
}

export interface InstallSelectedSkillsResult {
  installed: ManagedSkillEntry[];
  failed?: {
    sourceDir: string;
    error: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeSegment(value: string): string {
  const segment = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!(segment && ALPHANUMERIC_RE.test(segment))) {
    return "skill";
  }
  return segment;
}

function assertInsideDirectory(
  targetPath: string,
  rootDir: string,
  message: string
): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = resolve(targetPath);
  const relativeTarget = relative(resolvedRoot, resolvedTarget);
  if (
    !relativeTarget ||
    relativeTarget.startsWith("..") ||
    relativeTarget.includes(`..${sep}`)
  ) {
    throw new Error(`${message}: ${targetPath}`);
  }
  return resolvedTarget;
}

function assertInsideManagedDir(targetPath: string, paths: SkillsManagerPaths) {
  return assertInsideDirectory(
    targetPath,
    paths.managedDir,
    "Managed skill path escapes managed directory"
  );
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSlashPath(value: string): string {
  return value.replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
}

function listFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  function visit(current: string) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  visit(dir);
  return files.sort();
}

function filesHash(files: ManagedSkillFile[]): string {
  return hashString(
    files
      .map((file) => `${file.relativePath}\0${file.sha256}\0${file.bytes}`)
      .sort()
      .join("\n")
  );
}

function hashSourceIdentity(identity: Omit<SkillSourceIdentity, "id">): string {
  return hashString(JSON.stringify(identity)).slice(0, 16);
}

function isGitHubBlobItem(item: GitHubTreeItem): item is GitHubBlobItem {
  return item.type === "blob" && item.path !== undefined && item.path !== null;
}

function githubSkillRoot(item: GitHubBlobItem, prefix: string): string | null {
  if (
    item.path.startsWith(prefix) &&
    item.path.endsWith(`/${SKILL_FILE_NAME}`)
  ) {
    return item.path.slice(0, -`/${SKILL_FILE_NAME}`.length);
  }
  return null;
}

function stripGithubPrefix(itemPath: string, prefix: string): string {
  return prefix && itemPath.startsWith(prefix)
    ? itemPath.slice(prefix.length)
    : itemPath;
}

function githubSkillRootFolderName(root: string): string {
  return root.split("/").filter(Boolean).at(-1) ?? root;
}

function cleanMetadataValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim() || null;
  }
  return trimmed;
}

function stripFencedCodeBlocks(content: string): string {
  let inFence = false;
  return content
    .split(LINE_BREAK_RE)
    .filter((line) => {
      if (FENCE_START_RE.test(line)) {
        inFence = !inFence;
        return false;
      }
      return !inFence;
    })
    .join("\n");
}

function parseSkillMetadata(content: string): {
  name: string | null;
  description: string | null;
} {
  const frontmatter = content.match(FRONTMATTER_RE)?.[1] ?? "";
  const searchableContent = stripFencedCodeBlocks(content);
  return {
    name:
      cleanMetadataValue(frontmatter.match(NAME_RE)?.[1]) ??
      cleanMetadataValue(searchableContent.match(H1_RE)?.[1]) ??
      cleanMetadataValue(searchableContent.match(NAME_RE)?.[1]),
    description:
      cleanMetadataValue(frontmatter.match(DESCRIPTION_RE)?.[1]) ??
      cleanMetadataValue(searchableContent.match(DESCRIPTION_RE)?.[1]) ??
      cleanMetadataValue(searchableContent.match(DESCRIPTION_SECTION_RE)?.[1]),
  };
}

export function createSkillsManagerPaths(
  agentDir = join(process.env.HOME ?? homedir(), ".pi", "agent")
): SkillsManagerPaths {
  return {
    rootDir: agentDir,
    managedDir: join(agentDir, "skills"),
    cacheDir: join(agentDir, "skills-cache"),
    cachePath: join(agentDir, "skills-cache.json"),
    manifestPath: join(agentDir, "skills.json"),
    lockPath: join(agentDir, "skills.lock"),
  };
}

export function discoverBundledSkillPaths(skillsDir: string): string[] {
  const skillPaths: string[] = [];
  function discoverSkills(dir: string) {
    if (!existsSync(dir)) {
      return;
    }
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        discoverSkills(fullPath);
      } else if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
        skillPaths.push(fullPath);
      }
    }
  }
  discoverSkills(skillsDir);
  return skillPaths;
}

export function sourceIdentityForDirectory(
  sourceDir: string
): SkillSourceIdentity {
  const resolvedPath = resolve(sourceDir);
  const identity = { type: "directory" as const, path: resolvedPath };
  return { ...identity, id: hashSourceIdentity(identity) };
}

export function sourceIdentityForGithubSkillRoot(
  resolved: ResolvedSkillSource,
  skillRoot: string
): SkillSourceIdentity {
  if (
    resolved.identity.type !== "github" ||
    !resolved.identity.owner ||
    !resolved.identity.repo
  ) {
    throw new Error("Exact skill root identity requires a GitHub source.");
  }
  const subpath = normalizeSlashPath(skillRoot);
  const { owner, repo, ref = "HEAD" } = resolved.identity;
  const identityBase = {
    type: "github" as const,
    path: `${owner}/${repo}${subpath ? `/${subpath}` : ""}`,
    owner,
    repo,
    ref,
    subpath,
    url: `https://github.com/${owner}/${repo}`,
  };
  return { ...identityBase, id: hashSourceIdentity(identityBase) };
}

export function parseSkillSource(source: string): ResolvedSkillSource {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error("Skill source is required.");
  }
  const githubMatch = trimmed.match(GITHUB_SOURCE_RE);
  if (githubMatch && !existsSync(trimmed)) {
    const [, owner, repoWithGit, treeRef, treePath, hashRef] = githubMatch;
    const repo = repoWithGit.replace(GIT_SUFFIX_RE, "");
    const ref = hashRef ?? treeRef ?? "HEAD";
    const subpath = normalizeSlashPath(treePath ?? "");
    const path = `${owner}/${repo}${subpath ? `/${subpath}` : ""}`;
    const identityBase = {
      type: "github" as const,
      path,
      owner,
      repo,
      ref,
      subpath,
      url: `https://github.com/${owner}/${repo}`,
    };
    return {
      identity: { ...identityBase, id: hashSourceIdentity(identityBase) },
      displayName: path,
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${subpath ? `${subpath}/` : ""}${SKILL_FILE_NAME}`,
    };
  }
  if (PLAIN_HTTP_URL_RE.test(trimmed)) {
    throw new Error("Remote skill sources must use HTTPS.");
  }
  if (HTTP_URL_RE.test(trimmed)) {
    const identityBase = { type: "repo" as const, path: trimmed, url: trimmed };
    const rawUrl = trimmed.endsWith(SKILL_FILE_NAME)
      ? trimmed
      : `${trimmed.replace(TRAILING_SLASH_RE, "")}/${SKILL_FILE_NAME}`;
    return {
      identity: { ...identityBase, id: hashSourceIdentity(identityBase) },
      displayName: trimmed,
      rawUrl,
    };
  }
  return {
    identity: sourceIdentityForDirectory(trimmed),
    displayName: resolve(trimmed),
    localPath: resolve(trimmed),
  };
}

export function safeFileHash(filePath: string): ManagedSkillFile {
  const stats = statSync(filePath);
  if (!stats.isFile()) {
    throw new Error(`Cannot hash non-file path: ${filePath}`);
  }
  return {
    relativePath: basename(filePath),
    sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex"),
    bytes: stats.size,
  };
}

export function hashSkillDirectory(skillDir: string): ManagedSkillFile[] {
  return listFilesRecursive(skillDir).map((filePath) => ({
    ...safeFileHash(filePath),
    relativePath: normalizeSlashPath(relative(skillDir, filePath)),
  }));
}

export function computeSkillFilesHash(files: ManagedSkillFile[]): string {
  return filesHash(files);
}

export function validateSkillDirectory(
  skillDir: string
): SkillValidationResult {
  const skillPath = join(skillDir, SKILL_FILE_NAME);
  const errors: string[] = [];
  if (!existsSync(skillPath)) {
    return {
      ok: false,
      name: null,
      description: null,
      errors: ["Missing SKILL.md."],
    };
  }
  const content = readFileSync(skillPath, "utf8");
  const { name, description } = parseSkillMetadata(content);
  if (!name) {
    errors.push("SKILL.md must include an H1 skill name.");
  }
  if (!description) {
    errors.push("SKILL.md must include a description.");
  }
  return { ok: errors.length === 0, name, description, errors };
}

export function readManagedManifest(
  manifestPath: string
): ManagedSkillsManifest {
  if (!existsSync(manifestPath)) {
    return { version: MANIFEST_VERSION, skills: [] };
  }
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    !isRecord(parsed) ||
    parsed.version !== MANIFEST_VERSION ||
    !Array.isArray(parsed.skills)
  ) {
    throw new Error("Invalid skills manifest.");
  }
  return parsed as unknown as ManagedSkillsManifest;
}

export function writeManagedManifest(
  manifestPath: string,
  manifest: ManagedSkillsManifest
) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function planInstallSkill(
  sourceDir: string,
  paths: SkillsManagerPaths,
  manifest = readManagedManifest(paths.manifestPath)
): InstallPlan {
  const validation = validateSkillDirectory(sourceDir);
  if (!(validation.ok && validation.name)) {
    throw new Error(`Invalid skill: ${validation.errors.join(" ")}`);
  }
  const source = sourceIdentityForDirectory(sourceDir);
  const id = safeSegment(validation.name);
  const existing = manifest.skills.find(
    (skill) => skill.id === id || skill.source.id === source.id
  );
  const targetDir = assertInsideManagedDir(join(paths.managedDir, id), paths);
  return {
    id,
    sourceDir: resolve(sourceDir),
    targetDir,
    files: hashSkillDirectory(sourceDir),
    validation,
    action: existing ? "replace" : "install",
    existingId: existing?.id,
    existingInstallPath: existing?.installPath,
  };
}

export function copyInstallPlan(
  plan: InstallPlan,
  paths: SkillsManagerPaths,
  installedAt = new Date().toISOString(),
  sourceOverride?: SkillSourceIdentity
): ManagedSkillEntry {
  const targetDir = assertInsideManagedDir(plan.targetDir, paths);
  if (plan.existingInstallPath && plan.existingInstallPath !== targetDir) {
    rmSync(assertInsideManagedDir(plan.existingInstallPath, paths), {
      recursive: true,
      force: true,
    });
  }
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  for (const file of plan.files) {
    const targetFile = join(targetDir, file.relativePath);
    mkdirSync(dirname(targetFile), { recursive: true });
    copyFileSync(join(plan.sourceDir, file.relativePath), targetFile);
  }
  const source = sourceOverride ?? sourceIdentityForDirectory(plan.sourceDir);
  const entry: ManagedSkillEntry = {
    id: plan.id,
    name: plan.validation.name ?? plan.id,
    description: plan.validation.description ?? "",
    source,
    installPath: targetDir,
    installedAt,
    files: plan.files,
  };
  const manifest = readManagedManifest(paths.manifestPath);
  writeManagedManifest(paths.manifestPath, {
    version: MANIFEST_VERSION,
    skills: [
      ...manifest.skills.filter(
        (skill) => skill.id !== entry.id && skill.id !== plan.existingId
      ),
      entry,
    ],
  });
  return entry;
}

function isExpectedFileDirty(
  filePath: string,
  file: ManagedSkillFile
): boolean {
  if (!existsSync(filePath)) {
    return true;
  }
  if (!statSync(filePath).isFile()) {
    return true;
  }
  return safeFileHash(filePath).sha256 !== file.sha256;
}

export function detectDirtySkills(
  manifest: ManagedSkillsManifest
): DirtySkill[] {
  const dirty: DirtySkill[] = [];
  for (const skill of manifest.skills) {
    if (!existsSync(skill.installPath)) {
      dirty.push({
        id: skill.id,
        status: "missing",
        changedFiles: skill.files.map((file) => file.relativePath),
      });
      continue;
    }
    const expectedFiles = new Map(
      skill.files.map((file) => [file.relativePath, file])
    );
    const changedFiles = skill.files
      .filter((file) =>
        isExpectedFileDirty(join(skill.installPath, file.relativePath), file)
      )
      .map((file) => file.relativePath);
    const extraFiles = hashSkillDirectory(skill.installPath)
      .map((file) => file.relativePath)
      .filter((relativePath) => !expectedFiles.has(relativePath));
    changedFiles.push(...extraFiles);
    if (changedFiles.length > 0) {
      dirty.push({ id: skill.id, status: "dirty", changedFiles });
    }
  }
  return dirty;
}

export function planRemoveSkill(
  id: string,
  manifest: ManagedSkillsManifest
): RemovePlan {
  const entry = manifest.skills.find((skill) => skill.id === id);
  if (!entry) {
    throw new Error(`Managed skill not found: ${id}`);
  }
  return {
    id,
    installPath: entry.installPath,
    trashBoundary: "trash-cli",
    exists: existsSync(entry.installPath),
  };
}

export function applyRemovePlan(
  plan: RemovePlan,
  paths: SkillsManagerPaths,
  trash: (targetPath: string) => void
): ManagedSkillsManifest {
  if (plan.exists) {
    trash(assertInsideManagedDir(plan.installPath, paths));
  }
  const manifest = readManagedManifest(paths.manifestPath);
  const next: ManagedSkillsManifest = {
    version: MANIFEST_VERSION,
    skills: manifest.skills.filter((skill) => skill.id !== plan.id),
  };
  writeManagedManifest(paths.manifestPath, next);
  return next;
}

export function listSkillsInSource(sourceDir: string): ListedSkillSource[] {
  return discoverBundledSkillPaths(sourceDir).map((skillPath) => {
    const skillDir = dirname(skillPath);
    const validation = validateSkillDirectory(skillDir);
    if (!(validation.ok && validation.name)) {
      throw new Error(`Invalid skill in source: ${skillDir}`);
    }
    const identity = sourceIdentityForDirectory(skillDir);
    const files = hashSkillDirectory(skillDir);
    return {
      id: safeSegment(validation.name),
      name: validation.name,
      description: validation.description ?? "",
      sourceDir: skillDir,
      identity,
      hash: filesHash(files),
    };
  });
}

export function findListedSkillSourceDir(
  entries: ListedSkillSource[],
  requestedName: string
): string | undefined {
  const requestedId = safeSegment(requestedName);
  const matched = entries.find(
    (entry) =>
      entry.id === requestedId || safeSegment(entry.name) === requestedId
  );
  return (
    matched?.sourceDir ??
    (entries.length === 1 ? entries[0]?.sourceDir : undefined)
  );
}

export function installSelectedSkillsSequentially(
  entries: ListedSkillSource[],
  selectedSourceDirs: string[],
  paths: SkillsManagerPaths,
  sourceForEntry?: (entry: ListedSkillSource) => SkillSourceIdentity | undefined
): InstallSelectedSkillsResult {
  const selected = new Set(
    selectedSourceDirs.map((sourceDir) => resolve(sourceDir))
  );
  const installed: ManagedSkillEntry[] = [];
  for (const entry of entries) {
    if (!selected.has(resolve(entry.sourceDir))) {
      continue;
    }
    try {
      const manifest = readManagedManifest(paths.manifestPath);
      const plan = planInstallSkill(entry.sourceDir, paths, manifest);
      installed.push(
        copyInstallPlan(plan, paths, undefined, sourceForEntry?.(entry))
      );
    } catch (error) {
      return { installed, failed: { sourceDir: entry.sourceDir, error } };
    }
  }
  return { installed };
}

async function writeResponseFile(
  fetcher: SkillFetch,
  url: string,
  targetPath: string
): Promise<void> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, Buffer.from(await response.arrayBuffer()));
}

function sortedGithubSkillRoots(roots: Iterable<string>): string[] {
  return [...roots].sort((left, right) => {
    const leftScore = left.startsWith("skills/") ? 0 : 1;
    const rightScore = right.startsWith("skills/") ? 0 : 1;
    return leftScore - rightScore || left.localeCompare(right);
  });
}

function githubSkillNameCacheKey(
  owner: string,
  repo: string,
  ref: string,
  root: string
): string {
  return `${owner}/${repo}#${ref}:${root}`;
}

function exactGithubRoot(
  roots: Iterable<string>,
  requestedRoot: string | null
): string | null {
  if (requestedRoot) {
    return requestedRoot;
  }
  const rootList = [...roots];
  return rootList.length === 1 ? (rootList[0] ?? null) : null;
}

async function fetchGithubSkillRootName(
  fetcher: SkillFetch,
  owner: string,
  repo: string,
  ref: string,
  root: string,
  cache?: Map<string, string | null>
): Promise<string | null> {
  const cacheKey = githubSkillNameCacheKey(owner, repo, ref, root);
  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${root}/${SKILL_FILE_NAME}`;
  const response = await fetcher(rawUrl);
  if (!response.ok) {
    if (response.status === 404) {
      cache?.set(cacheKey, null);
      return null;
    }
    throw new Error(`Fetch failed: ${response.status}`);
  }
  const { name } = parseSkillMetadata(await response.text());
  cache?.set(cacheKey, name);
  return name;
}

async function findGithubSkillRootByNameFromRoots(
  fetcher: SkillFetch,
  owner: string,
  repo: string,
  ref: string,
  roots: Iterable<string>,
  requestedName: string,
  githubSkillNameCache?: Map<string, string | null>
): Promise<string | null> {
  const requestedId = safeSegment(requestedName);
  const matches = new Set<string>();
  for (const root of sortedGithubSkillRoots(roots)) {
    if (safeSegment(githubSkillRootFolderName(root)) === requestedId) {
      matches.add(root);
    }
    const name = await fetchGithubSkillRootName(
      fetcher,
      owner,
      repo,
      ref,
      root,
      githubSkillNameCache
    );
    if (name && safeSegment(name) === requestedId) {
      matches.add(root);
    }
  }
  const sortedMatches = [...matches].sort();
  if (sortedMatches.length > 1) {
    throw new Error(
      `Ambiguous GitHub skill source for ${requestedName}: ${sortedMatches.join(", ")}`
    );
  }
  return sortedMatches[0] ?? null;
}

function findGithubSkillRootByName(
  fetcher: SkillFetch,
  owner: string,
  repo: string,
  ref: string,
  blobItems: GitHubBlobItem[],
  requestedName: string,
  candidateRoots?: Iterable<string>,
  githubSkillNameCache?: Map<string, string | null>
): Promise<string | null> {
  const skillRoots =
    candidateRoots ??
    blobItems
      .map((item) => githubSkillRoot(item, ""))
      .filter((value): value is string => value !== null);
  return findGithubSkillRootByNameFromRoots(
    fetcher,
    owner,
    repo,
    ref,
    skillRoots,
    requestedName,
    githubSkillNameCache
  );
}

async function writeGithubSkillFiles(
  fetcher: SkillFetch,
  owner: string,
  repo: string,
  ref: string,
  sourceDir: string,
  blobItems: GitHubBlobItem[],
  roots: string[],
  relativePrefix: string
): Promise<void> {
  const rootPrefixes = roots.map((root) => `${root}/`);
  const skillFiles = blobItems.filter((item) =>
    rootPrefixes.some((rootPrefix) => item.path.startsWith(rootPrefix))
  );
  for (const item of skillFiles) {
    const relativePath = stripGithubPrefix(item.path, relativePrefix);
    const targetPath = assertInsideDirectory(
      join(sourceDir, relativePath),
      sourceDir,
      "Remote file path escapes source directory"
    );
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${item.path}`;
    await writeResponseFile(fetcher, rawUrl, targetPath);
  }
}

function githubTreePageUrl(
  owner: string,
  repo: string,
  ref: string,
  subpath: string
): string {
  return `https://github.com/${owner}/${repo}/tree/${ref}/${subpath}`;
}

function githubRawUrl(
  owner: string,
  repo: string,
  ref: string,
  path: string
): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function githubSkillRootsFromHtml(
  html: string,
  owner: string,
  repo: string,
  subpath: string
): string[] {
  const prefix = `${subpath.replace(TRAILING_SLASH_RE, "")}/`;
  const repoTreePrefix = `/${owner}/${repo}/tree/`;
  const roots = new Set<string>();
  for (const match of html.matchAll(HTML_HREF_RE)) {
    const href = decodeHtmlAttribute(match[1] ?? "");
    if (!href.startsWith(repoTreePrefix)) {
      continue;
    }
    const [, path = ""] = href.slice(repoTreePrefix.length).split(SLASH_RE, 2);
    const fullPath = href
      .slice(repoTreePrefix.length)
      .split("/")
      .slice(1)
      .join("/");
    if (!(path && fullPath.startsWith(prefix))) {
      continue;
    }
    const parts = fullPath.split("/").filter(Boolean);
    const prefixParts = prefix.split("/").filter(Boolean);
    const skillName = parts[prefixParts.length];
    if (skillName) {
      roots.add([...prefixParts, skillName].join("/"));
    }
  }
  return [...roots].sort();
}

async function writeGithubSkillMarkdownFiles(
  fetcher: SkillFetch,
  owner: string,
  repo: string,
  ref: string,
  sourceDir: string,
  roots: string[],
  relativePrefix: string
): Promise<void> {
  for (const root of roots) {
    const relativePath = stripGithubPrefix(
      `${root}/${SKILL_FILE_NAME}`,
      relativePrefix
    );
    const targetPath = assertInsideDirectory(
      join(sourceDir, relativePath),
      sourceDir,
      "Remote file path escapes source directory"
    );
    await writeResponseFile(
      fetcher,
      githubRawUrl(owner, repo, ref, `${root}/${SKILL_FILE_NAME}`),
      targetPath
    );
  }
}

async function materializeGithubSourceFromHtml(
  fetcher: SkillFetch,
  owner: string,
  repo: string,
  ref: string,
  sourceDir: string,
  subpath: string,
  requestedSkillName?: string,
  onExactRootResolved?: (root: string) => void,
  githubSkillNameCache?: Map<string, string | null>
): Promise<string | null> {
  const listingPath = subpath || "skills";
  const response = await fetcher(
    githubTreePageUrl(owner, repo, ref, listingPath)
  );
  if (!response.ok) {
    return null;
  }
  let roots = githubSkillRootsFromHtml(
    await response.text(),
    owner,
    repo,
    listingPath
  );
  if (requestedSkillName) {
    const requestedRoot = await findGithubSkillRootByNameFromRoots(
      fetcher,
      owner,
      repo,
      ref,
      roots,
      requestedSkillName,
      githubSkillNameCache
    );
    const exactRoot = exactGithubRoot(roots, requestedRoot);
    roots = exactRoot ? [exactRoot] : [];
    if (exactRoot) {
      onExactRootResolved?.(exactRoot);
    }
  }
  if (roots.length === 0) {
    return null;
  }
  await writeGithubSkillMarkdownFiles(
    fetcher,
    owner,
    repo,
    ref,
    sourceDir,
    roots,
    subpath ? `${subpath}/` : ""
  );
  return sourceDir;
}

async function fetchGithubTree(
  fetcher: SkillFetch,
  url: string
): Promise<Response> {
  const response = await fetcher(url);
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (
    response.ok ||
    !(response.status === 403 || response.status === 429) ||
    !token
  ) {
    return response;
  }
  return fetcher(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
}

function normalizeMaterializeOptions(
  requestedSkillNameOrOptions?: string | MaterializeResolvedSkillSourceOptions
): MaterializeResolvedSkillSourceOptions {
  return typeof requestedSkillNameOrOptions === "string"
    ? { requestedSkillName: requestedSkillNameOrOptions }
    : (requestedSkillNameOrOptions ?? {});
}

export async function materializeResolvedSkillSource(
  resolved: ResolvedSkillSource,
  paths: SkillsManagerPaths,
  fetcher: SkillFetch = fetch,
  requestedSkillNameOrOptions?: string | MaterializeResolvedSkillSourceOptions
): Promise<string> {
  const {
    requestedSkillName,
    exactSubpath = false,
    onExactSourceResolved,
    githubSkillNameCache,
  } = normalizeMaterializeOptions(requestedSkillNameOrOptions);
  const sourceDir = assertInsideDirectory(
    join(paths.cacheDir, "direct-source", resolved.identity.id),
    paths.cacheDir,
    "Skill source cache path escapes cache directory"
  );
  rmSync(sourceDir, { recursive: true, force: true });
  mkdirSync(sourceDir, { recursive: true });

  if (
    resolved.identity.type === "github" &&
    resolved.identity.owner &&
    resolved.identity.repo
  ) {
    const { owner, repo, ref = "HEAD", subpath = "" } = resolved.identity;
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const response = await fetchGithubTree(fetcher, treeUrl);
    if (response.ok) {
      const payload: unknown = await response.json();
      const tree =
        isRecord(payload) && Array.isArray(payload.tree)
          ? (payload.tree.filter(isRecord) as GitHubTreeItem[])
          : [];
      const prefix = subpath ? `${subpath}/` : "";
      const blobItems = tree.filter(isGitHubBlobItem);
      const skillRoots = new Set(
        blobItems
          .map((item) => githubSkillRoot(item, prefix))
          .filter((value): value is string => value !== null)
      );
      const requestedName =
        requestedSkillName ?? subpath.split("/").filter(Boolean).at(-1);
      if (skillRoots.size > 0) {
        const requestedRoot = requestedSkillName
          ? await findGithubSkillRootByName(
              fetcher,
              owner,
              repo,
              ref,
              blobItems,
              requestedSkillName,
              skillRoots,
              githubSkillNameCache
            )
          : null;
        const exactRoot = exactGithubRoot(skillRoots, requestedRoot);
        await writeGithubSkillFiles(
          fetcher,
          owner,
          repo,
          ref,
          sourceDir,
          blobItems,
          requestedRoot ? [requestedRoot] : [...skillRoots],
          requestedRoot ? `${requestedRoot}/` : prefix
        );
        if (exactRoot) {
          onExactSourceResolved?.(
            sourceIdentityForGithubSkillRoot(resolved, exactRoot)
          );
        }
        return sourceDir;
      }
      const matchedRoot = requestedName
        ? await findGithubSkillRootByName(
            fetcher,
            owner,
            repo,
            ref,
            blobItems,
            requestedName,
            undefined,
            githubSkillNameCache
          )
        : null;
      if (matchedRoot) {
        await writeGithubSkillFiles(
          fetcher,
          owner,
          repo,
          ref,
          sourceDir,
          blobItems,
          [matchedRoot],
          `${matchedRoot}/`
        );
        onExactSourceResolved?.(
          sourceIdentityForGithubSkillRoot(resolved, matchedRoot)
        );
        return sourceDir;
      }
    }
    if (!exactSubpath) {
      const htmlSourceRoot = await materializeGithubSourceFromHtml(
        fetcher,
        owner,
        repo,
        ref,
        sourceDir,
        subpath,
        requestedSkillName,
        (root) =>
          onExactSourceResolved?.(
            sourceIdentityForGithubSkillRoot(resolved, root)
          ),
        githubSkillNameCache
      );
      if (htmlSourceRoot) {
        return htmlSourceRoot;
      }
    }
  }

  if (!resolved.rawUrl) {
    throw new Error("Remote source did not resolve to SKILL.md.");
  }
  await writeResponseFile(
    fetcher,
    resolved.rawUrl,
    join(sourceDir, SKILL_FILE_NAME)
  );
  if (resolved.identity.type === "github") {
    onExactSourceResolved?.(
      sourceIdentityForGithubSkillRoot(
        resolved,
        resolved.identity.subpath ?? ""
      )
    );
  }
  return sourceDir;
}

export function readSkillsSearchCache(cachePath: string): SkillsSearchCache {
  if (!existsSync(cachePath)) {
    return { version: SEARCH_CACHE_VERSION, fetchedAt: "", skills: [] };
  }
  const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
  if (!(isRecord(parsed) && Array.isArray(parsed.skills))) {
    throw new Error("Invalid skills search cache.");
  }
  if (parsed.version !== SEARCH_CACHE_VERSION) {
    return { version: SEARCH_CACHE_VERSION, fetchedAt: "", skills: [] };
  }
  return parsed as unknown as SkillsSearchCache;
}

export function writeSkillsSearchCache(
  cachePath: string,
  cache: SkillsSearchCache
) {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
}

export function searchCachedSkills(
  cache: SkillsSearchCache,
  query: string
): RemoteSkillMetadata[] {
  const terms = query.toLowerCase().split(WHITESPACE_RE).filter(Boolean);
  if (terms.length === 0) {
    return cache.skills;
  }
  return cache.skills.filter((skill) => {
    const haystack =
      `${skill.name} ${skill.description} ${skill.source}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export async function fetchSkillsShSearchCache(
  query: string,
  fetcher: SkillFetch = fetch,
  endpoint = "https://skills.sh/api/search"
): Promise<SkillsSearchCache> {
  const url = new URL(endpoint);
  if (query) {
    url.searchParams.set("q", query);
  }
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`skills.sh search failed: ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const skills = contentType.includes("json")
    ? skillsFromJsonPayload(await response.json())
    : skillsFromHtml(await response.text());
  return {
    version: SEARCH_CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    query,
    skills,
  };
}

function numericInstallCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function skillsFromJsonPayload(payload: unknown): RemoteSkillMetadata[] {
  let rows: unknown[] = [];
  if (Array.isArray(payload)) {
    rows = payload;
  } else if (isRecord(payload) && Array.isArray(payload.skills)) {
    rows = payload.skills;
  }
  return rows.filter(isRecord).map((row) => {
    const source = String(row.source ?? row.url ?? row.repository ?? "");
    const skillId = typeof row.skillId === "string" ? row.skillId : undefined;
    const name = String(row.name ?? skillId ?? "");
    return {
      name,
      description: String(row.description ?? source),
      source,
      skillName: name || skillId,
      installs: numericInstallCount(row.installs),
      url: typeof row.url === "string" ? row.url : source,
      repository: typeof row.repository === "string" ? row.repository : source,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : undefined,
    };
  });
}

function skillsFromHtml(html: string): RemoteSkillMetadata[] {
  const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const results: RemoteSkillMetadata[] = [];
  for (const match of html.matchAll(linkRe)) {
    const href = match[1] ?? "";
    const relativeParts = href.startsWith("/")
      ? href.split("/").filter(Boolean)
      : [];
    const isRelativeSkill = relativeParts.length === 3;
    const isGitHubSkill = href.startsWith("https://github.com/");
    if (!(isRelativeSkill || isGitHubSkill)) {
      continue;
    }
    const text = (match[2] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const source = isRelativeSkill
      ? `https://github.com/${relativeParts[0]}/${relativeParts[1]}/tree/HEAD/skills/${relativeParts[2]}`
      : href;
    const name =
      text ||
      (isRelativeSkill
        ? (relativeParts[2] ?? href)
        : href.split("/").filter(Boolean).at(-1) || href);
    results.push({
      name,
      description: isRelativeSkill
        ? `${relativeParts[0]}/${relativeParts[1]}`
        : "",
      source,
      skillName: name,
      url: source,
      repository: source,
    });
  }
  return results;
}

export function detectSkillUpdate(
  entry: ManagedSkillEntry,
  latestFiles: ManagedSkillFile[] | null
): SkillUpdateStatus {
  const installedHash = filesHash(entry.files);
  const remoteManaged = entry.source.type !== "directory";
  if (!latestFiles) {
    return {
      id: entry.id,
      installedHash,
      latestHash: null,
      updateAvailable: false,
      remoteManaged,
      reason: remoteManaged ? "latest-unavailable" : "local-source",
    };
  }
  const latestHash = filesHash(latestFiles);
  return {
    id: entry.id,
    installedHash,
    latestHash,
    updateAvailable: installedHash !== latestHash,
    remoteManaged,
  };
}

export function detectLocalSkillUpdate(
  entry: ManagedSkillEntry
): SkillUpdateStatus {
  if (entry.source.type !== "directory" || !existsSync(entry.source.path)) {
    return detectSkillUpdate(entry, null);
  }
  return detectSkillUpdate(entry, hashSkillDirectory(entry.source.path));
}

export function withSkillsWriteLock<T>(
  paths: SkillsManagerPaths,
  action: () => T
): T {
  mkdirSync(dirname(paths.lockPath), { recursive: true });
  let fd: number | null = null;
  try {
    fd = openSync(paths.lockPath, "wx");
  } catch {
    throw new Error("Skills manager is locked by another writer.");
  }
  try {
    return action();
  } finally {
    if (fd !== null) {
      closeSync(fd);
      rmSync(paths.lockPath, { force: true });
    }
  }
}
