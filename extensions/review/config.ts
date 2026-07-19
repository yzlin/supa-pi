import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertVerifierModelPolicy,
  DEFAULT_REVIEWER_PANEL,
  DEFAULT_SYNTHESIZER_MODEL,
  DEFAULT_VERIFIER_MODEL,
  type ReviewPanelEntry,
  type ReviewThinkingLevel,
} from "./workflow";

export interface ReviewModelConfig {
  $schema?: string;
  reviewerPanel?: ReviewPanelEntry[];
  synthesizerModel?: string;
  verifierModel?: string;
}

export interface EffectiveReviewModels {
  reviewerPanel: ReviewPanelEntry[];
  synthesizerModel: string;
  verifierModel: string;
}

export interface ReviewConfigLayer {
  path: string;
  config: ReviewModelConfig;
  content?: string;
  hash?: string;
}

export interface ResolvedReviewConfig {
  global: ReviewConfigLayer;
  project: ReviewConfigLayer;
  effective: EffectiveReviewModels;
}

interface ReviewTrustFile {
  $schema?: string;
  approvals?: Array<{ path: string; hash: string }>;
}

const MODEL_FIELDS = [
  "reviewerPanel",
  "synthesizerModel",
  "verifierModel",
] as const;
const CONFIG_KEYS = new Set(["$schema", ...MODEL_FIELDS]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MODEL_ID_PATTERN = /^[^\s/]+\/[^\s]+$/;
const MODEL_CONTROL_OR_FORMAT_RE = /[\p{Cc}\p{Cf}]/u;
const THINKING_LEVELS = new Set<ReviewThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const FILE_LOCK_STALE_MS = 30_000;
const FILE_LOCK_RETRIES = 100;
const FILE_LOCK_RETRY_MS = 50;

function agentHome(): string {
  return path.join(process.env.HOME || os.homedir(), ".pi", "agent");
}

export function getGlobalReviewConfigPath(): string {
  return path.join(agentHome(), "review.json");
}

export function getReviewTrustPath(): string {
  return path.join(agentHome(), "review-trust.json");
}

export async function getProjectReviewConfigPath(cwd: string): Promise<string> {
  const canonicalCwd = await fs.realpath(cwd);
  return path.join(canonicalCwd, ".pi", "review.json");
}

function fail(file: string, field: string, message: string): never {
  throw new Error(`Invalid review config ${file} field '${field}': ${message}`);
}

function validateModel(value: unknown, file: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(file, field, "must be a nonblank provider/model string.");
  }
  const model = value.trim();
  if (!MODEL_ID_PATTERN.test(model) || MODEL_CONTROL_OR_FORMAT_RE.test(model)) {
    fail(
      file,
      field,
      "must use provider/model without whitespace, control, or Unicode format characters."
    );
  }
  return model;
}

export function validateReviewConfig(
  value: unknown,
  file: string
): ReviewModelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(file, "$", "must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CONFIG_KEYS.has(key)) {
      fail(file, key, "is not an allowed key.");
    }
  }
  const config: ReviewModelConfig = {};
  if (record.$schema !== undefined) {
    if (typeof record.$schema !== "string") {
      fail(file, "$schema", "must be a string.");
    }
    config.$schema = record.$schema;
  }
  if (record.reviewerPanel !== undefined) {
    if (
      !Array.isArray(record.reviewerPanel) ||
      record.reviewerPanel.length < 1 ||
      record.reviewerPanel.length > 4
    ) {
      fail(file, "reviewerPanel", "must contain 1–4 entries.");
    }
    const seen = new Set<string>();
    config.reviewerPanel = record.reviewerPanel.map((item, index) => {
      const field = `reviewerPanel[${index}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        fail(file, field, "must be an object.");
      }
      const entry = item as Record<string, unknown>;
      for (const key of Object.keys(entry)) {
        if (key !== "model" && key !== "thinkingLevel") {
          fail(file, `${field}.${key}`, "is not an allowed key.");
        }
      }
      const model = validateModel(entry.model, file, `${field}.model`);
      if (!THINKING_LEVELS.has(entry.thinkingLevel as ReviewThinkingLevel)) {
        fail(
          file,
          `${field}.thinkingLevel`,
          "must be off, minimal, low, medium, high, or xhigh."
        );
      }
      if (seen.has(model)) {
        fail(file, `${field}.model`, "must be distinct within the panel.");
      }
      seen.add(model);
      return {
        model,
        thinkingLevel: entry.thinkingLevel as ReviewThinkingLevel,
      };
    });
  }
  if (record.synthesizerModel !== undefined) {
    config.synthesizerModel = validateModel(
      record.synthesizerModel,
      file,
      "synthesizerModel"
    );
  }
  if (record.verifierModel !== undefined) {
    config.verifierModel = validateModel(
      record.verifierModel,
      file,
      "verifierModel"
    );
  }
  if (config.reviewerPanel && config.verifierModel) {
    try {
      assertVerifierModelPolicy(config.verifierModel, config.reviewerPanel);
    } catch (error) {
      fail(
        file,
        "verifierModel",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return config;
}

async function readLayer(
  file: string,
  project: boolean
): Promise<ReviewConfigLayer> {
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: file, config: {} };
    }
    throw new Error(`Could not read review config ${file}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid review config ${file} field '$': malformed JSON (${error instanceof Error ? error.message : String(error)}).`
    );
  }
  const config = validateReviewConfig(parsed, file);
  const hasProjectModels = MODEL_FIELDS.some(
    (field) => config[field] !== undefined
  );
  return {
    path: file,
    config,
    content: project ? content : undefined,
    hash:
      project && hasProjectModels
        ? createHash("sha256").update(content).digest("hex")
        : undefined,
  };
}

function copyPanel(panel: readonly ReviewPanelEntry[]): ReviewPanelEntry[] {
  return panel.map((entry) => ({ ...entry }));
}

async function loadReviewConfig(
  cwd: string,
  explicit: Partial<EffectiveReviewModels>
): Promise<ResolvedReviewConfig> {
  const global = await readLayer(getGlobalReviewConfigPath(), false);
  const project = await readLayer(await getProjectReviewConfigPath(cwd), true);
  const effective: EffectiveReviewModels = {
    reviewerPanel: copyPanel(
      explicit.reviewerPanel ??
        project.config.reviewerPanel ??
        global.config.reviewerPanel ??
        DEFAULT_REVIEWER_PANEL
    ),
    synthesizerModel:
      explicit.synthesizerModel ??
      project.config.synthesizerModel ??
      global.config.synthesizerModel ??
      DEFAULT_SYNTHESIZER_MODEL,
    verifierModel:
      explicit.verifierModel ??
      project.config.verifierModel ??
      global.config.verifierModel ??
      DEFAULT_VERIFIER_MODEL,
  };
  return { global, project, effective };
}

export async function resolveReviewConfigForEditing(
  cwd: string
): Promise<ResolvedReviewConfig> {
  // Each file is still parsed and validated strictly. Only a cross-layer
  // effective-bundle conflict is deferred so the selector can repair it.
  return await loadReviewConfig(cwd, {});
}

export async function resolveReviewConfig(
  cwd: string,
  explicit: Partial<EffectiveReviewModels> = {}
): Promise<ResolvedReviewConfig> {
  const resolved = await loadReviewConfig(cwd, explicit);
  validateReviewConfig(resolved.effective, "<effective review configuration>");
  return resolved;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

async function assertSafeProjectConfigWrite(file: string): Promise<void> {
  const absoluteFile = path.resolve(file);
  const projectRoot = path.dirname(path.dirname(absoluteFile));
  const canonicalRoot = await fs.realpath(projectRoot);
  const expectedFile = path.join(canonicalRoot, ".pi", "review.json");
  if (absoluteFile !== expectedFile) {
    throw new Error(`Refusing unsafe project review config path ${file}.`);
  }

  const piDirectory = path.dirname(absoluteFile);
  const piStat: Stats | undefined = await fs
    .lstat(piDirectory)
    .catch((error): Stats | undefined => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    });
  if (piStat?.isSymbolicLink()) {
    throw new Error(
      `Refusing project review config write through symlinked directory ${piDirectory}.`
    );
  }
  const resolvedDirectory = piStat
    ? await fs.realpath(piDirectory)
    : piDirectory;
  if (!isWithin(canonicalRoot, resolvedDirectory)) {
    throw new Error(
      `Refusing project review config write outside ${canonicalRoot}.`
    );
  }

  const resolvedFile = await fs.realpath(absoluteFile).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return absoluteFile;
    }
    throw error;
  });
  if (
    !isWithin(canonicalRoot, resolvedFile) ||
    resolvedFile === path.resolve(getGlobalReviewConfigPath())
  ) {
    throw new Error(
      `Refusing unsafe project review config destination ${resolvedFile}.`
    );
  }
}

export async function writeReviewConfigField(
  file: string,
  field: (typeof MODEL_FIELDS)[number],
  value: ReviewModelConfig[typeof field]
): Promise<ReviewConfigLayer> {
  const global = path.resolve(getGlobalReviewConfigPath());
  const project = path.resolve(file) !== global;
  if (project) {
    await assertSafeProjectConfigWrite(file);
  }
  return await withFileLock(file, async () => {
    if (project) {
      await assertSafeProjectConfigWrite(file);
    }
    const existing = await readLayer(file, project);
    const next: ReviewModelConfig = { ...existing.config };
    if (value === undefined) {
      delete next[field];
    } else {
      (next as Record<string, unknown>)[field] = value;
    }
    validateReviewConfig(next, file);
    if (!MODEL_FIELDS.some((key) => next[key] !== undefined)) {
      if (project) {
        await assertSafeProjectConfigWrite(file);
      }
      await fs.rm(file, { force: true });
      return { path: file, config: {} };
    }
    const content = `${JSON.stringify(next, null, 2)}\n`;
    if (project) {
      await assertSafeProjectConfigWrite(file);
    }
    await atomicWrite(file, content);
    return {
      path: file,
      config: next,
      content,
      hash: createHash("sha256").update(content).digest("hex"),
    };
  });
}

function validateTrust(value: unknown, file: string): ReviewTrustFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Invalid review trust file ${file}: must be a JSON object.`
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "$schema" && key !== "approvals") {
      throw new Error(
        `Invalid review trust file ${file} field '${key}': is not allowed.`
      );
    }
  }
  if (record.$schema !== undefined && typeof record.$schema !== "string") {
    throw new Error(
      `Invalid review trust file ${file} field '$schema': must be a string.`
    );
  }
  const approvalsValue = record.approvals;
  let approvalItems: unknown[] = [];
  if (approvalsValue !== undefined) {
    if (!Array.isArray(approvalsValue)) {
      throw new Error(
        `Invalid review trust file ${file} field 'approvals': must be an array.`
      );
    }
    approvalItems = approvalsValue;
  }
  const approvals = approvalItems.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(
        `Invalid review trust file ${file} field 'approvals[${index}]'.`
      );
    }
    const approval = item as Record<string, unknown>;
    if (
      Object.keys(approval).some((key) => key !== "path" && key !== "hash") ||
      typeof approval.path !== "string" ||
      typeof approval.hash !== "string" ||
      !SHA256_PATTERN.test(approval.hash)
    ) {
      throw new Error(
        `Invalid review trust file ${file} field 'approvals[${index}]'.`
      );
    }
    return { path: approval.path, hash: approval.hash };
  });
  return { $schema: record.$schema as string | undefined, approvals };
}

async function readTrust(): Promise<ReviewTrustFile> {
  const file = getReviewTrustPath();
  try {
    return validateTrust(JSON.parse(await fs.readFile(file, "utf8")), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { approvals: [] };
    }
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid review trust file ${file}: malformed JSON (${error.message}).`
      );
    }
    throw error;
  }
}

export async function isProjectReviewConfigApproved(
  layer: ReviewConfigLayer
): Promise<boolean> {
  if (!layer.hash) {
    return true;
  }
  const trust = await readTrust();
  return Boolean(
    trust.approvals?.some(
      (approval) => approval.path === layer.path && approval.hash === layer.hash
    )
  );
}

async function withFileLock<T>(
  file: string,
  run: () => Promise<T>
): Promise<T> {
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < FILE_LOCK_RETRIES; attempt += 1) {
    let acquired = false;
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const stat = await fs.stat(lock).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > FILE_LOCK_STALE_MS) {
        await fs
          .rm(lock, { recursive: true, force: true })
          .catch(() => undefined);
      }
    }
    if (acquired) {
      try {
        return await run();
      } finally {
        await fs.rm(lock, { recursive: true, force: true });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, FILE_LOCK_RETRY_MS));
  }
  throw new Error(`Timed out waiting for review file lock ${lock}.`);
}

export async function approveProjectReviewConfig(
  layer: ReviewConfigLayer
): Promise<void> {
  if (!layer.hash) {
    return;
  }
  const current = await readLayer(layer.path, true);
  if (current.hash !== layer.hash) {
    throw new Error(
      `Project review config ${layer.path} changed before approval; inspect and approve its new content.`
    );
  }
  await withFileLock(getReviewTrustPath(), async () => {
    const trust = await readTrust();
    const approvals = (trust.approvals ?? []).filter(
      (approval) => approval.path !== layer.path
    );
    approvals.push({ path: layer.path, hash: layer.hash });
    await atomicWrite(
      getReviewTrustPath(),
      `${JSON.stringify({ ...trust, approvals }, null, 2)}\n`
    );
  });
}
