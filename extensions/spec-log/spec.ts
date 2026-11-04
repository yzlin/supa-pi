import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const SPECS_DIR = ".pi/specs";
export const SPEC_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
export const RESERVED_SLUGS: readonly string[] = ["status"];

const SECTIONS = [
  "Execution Scope",
  "User Stories",
  "Plan",
  "Done Criteria",
  "Verification",
  "Testing Seams",
  "Out of Scope",
] as const;
const OPTIONAL_SECTIONS = new Set<string>(["Testing Seams"]);
const DC_ROW = /^- (DC-[1-9][0-9]*): (\S.*)$/u;
const US_ID = /\bUS-[1-9][0-9]*\b/gu;
const US_DEFINITION = /^(?:- |\d+\. )?(?:\*\*)?(US-[1-9][0-9]*)\b/u;
const EVIDENCE_LINE = /^\s+Evidence: \S/u;
const INTERNAL_STORIES = /^N\/A — internal: \S/u;

const text = Type.String({ minLength: 1 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const ts = Type.String({ format: "date-time" });
const closed = { additionalProperties: false };
export const SpecLogEventSchema = Type.Union([
  Type.Object(
    {
      ts,
      event: Type.Literal("accepted"),
      hash,
      criteria: Type.Array(text, { minItems: 1 }),
      content: Type.String(),
    },
    closed,
  ),
  Type.Object(
    { ts, event: Type.Literal("revised"), hash, previousHash: hash },
    closed,
  ),
  Type.Object(
    {
      ts,
      event: Type.Literal("reviewed"),
      hash,
      decision: Type.Union([
        Type.Literal("accept"),
        Type.Literal("revise"),
        Type.Literal("stop"),
      ]),
      findings: Type.Integer({ minimum: 0 }),
    },
    closed,
  ),
  Type.Object(
    {
      ts,
      event: Type.Literal("checked"),
      id: text,
      evidence: text,
      head: Type.Union([text, Type.Null()]),
      snapshot: Type.Union([text, Type.Null()]),
      snapshotError: Type.Optional(text),
    },
    closed,
  ),
  Type.Object(
    {
      ts,
      event: Type.Literal("blocked"),
      id: Type.Optional(text),
      reason: text,
    },
    closed,
  ),
  Type.Object({ ts, event: Type.Literal("stopped"), reason: text }, closed),
  Type.Object({ ts, event: Type.Literal("done") }, closed),
]);
export type SpecLogEvent = Static<typeof SpecLogEventSchema>;
type Accepted = Extract<SpecLogEvent, { event: "accepted" }>;

/** A log written before P4 (execute_checkpoint ledger era). Readable for status only. */
export class LegacySpecLogError extends Error {
  readonly lastEvent: string;
  constructor(path: string, lastEvent: string) {
    super(
      `Spec log ${path} predates the spec_log tool; it cannot be resumed. Use a new slug.`,
    );
    this.lastEvent = lastEvent;
    this.name = "LegacySpecLogError";
  }
}

export function validSlug(slug: string): boolean {
  return (
    slug.length <= 48 &&
    SPEC_SLUG_PATTERN.test(slug) &&
    !RESERVED_SLUGS.includes(slug)
  );
}

export function parseSpecPath(specPath: string): {
  slug: string;
  specPath: string;
  logPath: string;
} {
  const normalized = specPath.startsWith("@") ? specPath.slice(1) : specPath;
  const prefix = `${SPECS_DIR}/`;
  const slug = normalized.slice(prefix.length, -3);
  if (!validSlug(slug) || normalized !== `${prefix}${slug}.md`) {
    throw new Error(
      `Invalid Spec path: ${specPath}. Use ${SPECS_DIR}/<slug>.md.`,
    );
  }
  return { slug, specPath: normalized, logPath: `${prefix}${slug}.log.jsonl` };
}

export function hashSpec(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sections(content: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of content.split(/\r?\n/u)) {
    const heading = /^## (.+?)\s*$/u.exec(line)?.[1];
    if (heading) {
      current = [];
      result.set(heading, current);
    } else if (current) {
      current.push(line);
    }
  }
  return result;
}

export interface DoneCriterion {
  id: string;
  text: string;
}

/** Done Criteria rows, in order. Throws only when the section is missing. */
export function doneCriteria(content: string): DoneCriterion[] {
  const rows = sections(content).get("Done Criteria");
  if (!rows) {
    throw new Error("Spec has no ## Done Criteria section");
  }
  return rows.flatMap((line) => {
    const match = DC_ROW.exec(line);
    return match ? [{ id: match[1] as string, text: match[2] as string }] : [];
  });
}

/** Lints Spec shape. Returns every problem found; an empty list means valid. */
export function lintSpec(content: string): string[] {
  const errors: string[] = [];
  const firstLine = content.split(/\r?\n/u).find((line) => line.trim());
  if (firstLine !== "# Execution Brief") {
    errors.push("First line must be `# Execution Brief`.");
  }
  const found = sections(content);
  const headings = [...found.keys()];
  for (const heading of headings) {
    if (!(SECTIONS as readonly string[]).includes(heading)) {
      errors.push(`Unknown section: ## ${heading}`);
    }
  }
  const order = headings.filter((heading) =>
    (SECTIONS as readonly string[]).includes(heading),
  );
  const expected = SECTIONS.filter(
    (heading) => !OPTIONAL_SECTIONS.has(heading) || found.has(heading),
  );
  for (const heading of expected) {
    if (!found.has(heading)) {
      errors.push(`Missing section: ## ${heading}`);
    }
  }
  if (
    expected.every((heading) => found.has(heading)) &&
    order.join("|") !== expected.join("|")
  ) {
    errors.push(`Sections must appear in order: ${expected.join(", ")}.`);
  }

  const rows = found.get("Done Criteria") ?? [];
  const ids: string[] = [];
  const cited = new Set<string>();
  let lastId: string | null = null;
  let lastHasEvidence = true;
  const closeRow = () => {
    if (lastId && !lastHasEvidence) {
      errors.push(
        `${lastId} names no evidence; add an indented \`Evidence: <command or check>\` line.`,
      );
    }
  };
  for (const line of rows) {
    if (!line.trim()) {
      continue;
    }
    if (/^\s/u.test(line)) {
      if (EVIDENCE_LINE.test(line)) {
        lastHasEvidence = true;
      }
      continue;
    }
    closeRow();
    const match = DC_ROW.exec(line);
    if (!match) {
      errors.push(`Done Criteria row lacks a \`- DC-n: \` label: ${line}`);
      lastId = null;
      continue;
    }
    const id = match[1] as string;
    if (ids.includes(id)) {
      errors.push(`Repeated Done Criterion label: ${id}`);
    }
    ids.push(id);
    lastId = id;
    lastHasEvidence = false;
    const refs = match[2]?.match(US_ID) ?? [];
    if (!refs.length && !/\(technical\)\s*$/u.test(line)) {
      errors.push(`${id} must end with (US-n) citations or (technical).`);
    }
    for (const ref of refs) {
      cited.add(ref);
    }
  }
  closeRow();
  if (found.has("Done Criteria") && !ids.length) {
    errors.push("## Done Criteria has no rows.");
  }

  const stories = (found.get("User Stories") ?? []).filter((line) =>
    line.trim(),
  );
  if (found.has("User Stories")) {
    const internal =
      stories.length === 1 && INTERNAL_STORIES.test(stories[0] ?? "");
    const defined = new Set(
      stories.flatMap((line) => {
        const id = US_DEFINITION.exec(line)?.[1];
        return id ? [id] : [];
      }),
    );
    if (!(internal || defined.size)) {
      errors.push(
        "## User Stories needs numbered US-n stories or exactly `N/A — internal: <reason>`.",
      );
    }
    for (const story of defined) {
      if (!cited.has(story)) {
        errors.push(`${story} is not covered by any Done Criterion.`);
      }
    }
    for (const ref of cited) {
      if (!defined.has(ref)) {
        errors.push(`A Done Criterion cites unknown story ${ref}.`);
      }
    }
  }
  return errors;
}

/**
 * Reads a Spec log. Missing file → []. Invalid JSON → corrupt (throws Error).
 * Valid JSON in an older shape → LegacySpecLogError.
 */
export function readSpecLog(absLogPath: string): SpecLogEvent[] {
  let content: string;
  try {
    content = readFileSync(absLogPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const raw: unknown[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (!line.trim()) {
      continue;
    }
    try {
      raw.push(JSON.parse(line));
    } catch {
      throw new Error(`Corrupt Spec log ${absLogPath}:${index + 1}`);
    }
  }
  const events: SpecLogEvent[] = [];
  for (const event of raw) {
    if (!Value.Check(SpecLogEventSchema, event)) {
      const last = raw.at(-1) as { event?: unknown } | undefined;
      throw new LegacySpecLogError(
        absLogPath,
        typeof last?.event === "string" ? last.event : "unknown",
      );
    }
    if (
      !events.some((item) => item.event === "accepted") &&
      event.event !== "accepted" &&
      event.event !== "reviewed"
    ) {
      throw new Error(
        `Corrupt Spec log ${absLogPath}: ${event.event} before accepted`,
      );
    }
    events.push(event);
  }
  return events;
}

/** True when any line records acceptance. Unreadable logs fail closed as accepted. */
export function logAccepted(absLogPath: string): boolean {
  let content: string;
  try {
    content = readFileSync(absLogPath, "utf8");
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    );
  }
  try {
    return content
      .split("\n")
      .filter((line) => line.trim())
      .some(
        (line) =>
          (JSON.parse(line) as { event?: unknown }).event === "accepted",
      );
  } catch {
    return true;
  }
}

export function appendSpecEvents(
  absLogPath: string,
  events: SpecLogEvent[],
): void {
  if (!events.length) {
    return;
  }
  mkdirSync(dirname(absLogPath), { recursive: true });
  const existing = existsSync(absLogPath)
    ? readFileSync(absLogPath, "utf8")
    : "";
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(
    absLogPath,
    `${separator}${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

export type CriterionState =
  | { state: "open" }
  | { state: "checked"; evidence: string; snapshot: string | null }
  | { state: "blocked"; reason: string };

export interface SpecState {
  phase: "ready" | "reviewed" | "accepted" | "done" | "stopped";
  accepted: Accepted | null;
  criteria: Map<string, CriterionState>;
  blockers: string[];
  checkedCount: number;
}

/** Derives the current state. Only events after the latest acceptance count. */
export function deriveSpecState(events: SpecLogEvent[]): SpecState {
  const start = events.findLastIndex((event) => event.event === "accepted");
  const accepted = (events[start] as Accepted | undefined) ?? null;
  const criteria = new Map<string, CriterionState>(
    (accepted?.criteria ?? []).map((id) => [id, { state: "open" }]),
  );
  const blockers: string[] = [];
  let phase: SpecState["phase"] = "ready";
  if (accepted) {
    phase = "accepted";
  } else if (events.length) {
    phase = "reviewed";
  }
  for (const event of start === -1 ? [] : events.slice(start + 1)) {
    if (event.event === "checked") {
      criteria.set(event.id, {
        state: "checked",
        evidence: event.evidence,
        snapshot: event.snapshot,
      });
    } else if (event.event === "blocked") {
      if (event.id) {
        criteria.set(event.id, { state: "blocked", reason: event.reason });
      } else {
        blockers.push(event.reason);
      }
    } else if (event.event === "done") {
      phase = "done";
    } else if (event.event === "stopped") {
      phase = "stopped";
    }
  }
  return {
    phase,
    accepted,
    criteria,
    blockers,
    checkedCount: events.filter((event) => event.event === "checked").length,
  };
}

export function allChecked(state: SpecState): boolean {
  return (
    state.criteria.size > 0 &&
    [...state.criteria.values()].every((item) => item.state === "checked")
  );
}

function git(cwd: string, args: string[], env = process.env): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  }).trim();
}

function isWorkTree(cwd: string): boolean {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

/** Records the working tree as `refs/pi-specs/<slug>/<n>` without touching the real index. */
export function snapshotWorkspace(
  cwd: string,
  slug: string,
  n: number,
): { head: string | null; snapshot: string | null; snapshotError?: string } {
  if (!isWorkTree(cwd)) {
    return { head: null, snapshot: null };
  }
  let head: string | null = null;
  try {
    head = git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]) || null;
  } catch {
    // An unborn work tree has no HEAD yet.
  }
  let temporary: string | null = null;
  try {
    temporary = mkdtempSync(join(tmpdir(), "pi-spec-index-"));
    const index = join(temporary, "index");
    const realIndex = resolve(
      cwd,
      git(cwd, ["rev-parse", "--git-path", "index"]),
    );
    if (existsSync(realIndex)) {
      copyFileSync(realIndex, index);
    }
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(cwd, ["add", "-A", ":/"], env);
    const tree = git(cwd, ["write-tree"], env);
    const commit = git(
      cwd,
      [
        "commit-tree",
        tree,
        ...(head ? ["-p", head] : []),
        "-m",
        `pi-spec ${slug} #${n}`,
      ],
      {
        ...env,
        GIT_AUTHOR_NAME: "pi-spec",
        GIT_AUTHOR_EMAIL: "pi-spec@localhost",
        GIT_COMMITTER_NAME: "pi-spec",
        GIT_COMMITTER_EMAIL: "pi-spec@localhost",
      },
    );
    const ref = `refs/pi-specs/${slug}/${n}`;
    git(cwd, ["update-ref", ref, commit]);
    return { head, snapshot: ref };
  } catch (error) {
    return {
      head,
      snapshot: null,
      snapshotError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (temporary) {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

export function deleteSnapshotRefs(cwd: string, slug: string): void {
  if (!isWorkTree(cwd)) {
    return;
  }
  const refs = git(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    `refs/pi-specs/${slug}/`,
  ]);
  for (const ref of refs.split("\n").filter(Boolean)) {
    git(cwd, ["update-ref", "-d", ref]);
  }
}

function phaseLabel(state: SpecState): string {
  return state.phase === "reviewed" ? "reviewed (not accepted)" : state.phase;
}

function readStatus(absLogPath: string): SpecState | string {
  try {
    return deriveSpecState(readSpecLog(absLogPath));
  } catch (error) {
    return error instanceof LegacySpecLogError
      ? `legacy (pre-P4): ${error.lastEvent}`
      : "corrupt";
  }
}

/** Deterministic status text for `/to-spec status` and `spec_log` results. */
export function renderSpecStatus(cwd: string, slug?: string): string {
  const directory = join(cwd, SPECS_DIR);
  if (slug === undefined) {
    const specs = existsSync(directory)
      ? readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
          .map((entry) => entry.name.slice(0, -3))
          .sort((a, b) => a.localeCompare(b))
      : [];
    if (!specs.length) {
      return "No specs in .pi/specs/. Run /to-spec after locking a plan.";
    }
    return specs
      .map((name) => {
        const state = readStatus(join(directory, `${name}.log.jsonl`));
        if (typeof state === "string") {
          return `${name}  ${state}`;
        }
        const total = state.criteria.size;
        const checked = [...state.criteria.values()].filter(
          (item) => item.state === "checked",
        ).length;
        return `${name}  ${phaseLabel(state)}${total ? `  ${checked}/${total}` : ""}`;
      })
      .join("\n");
  }
  if (!validSlug(slug)) {
    return `Invalid Spec slug: ${slug}. Use 1–48 lowercase letters, digits or hyphens, starting with a letter or digit; status is reserved.`;
  }
  const { specPath, logPath } = parseSpecPath(`${SPECS_DIR}/${slug}.md`);
  if (!existsSync(join(cwd, specPath))) {
    return `Spec not found: ${specPath}`;
  }
  const state = readStatus(join(cwd, logPath));
  if (typeof state === "string") {
    return `${specPath}\nStatus: ${state}`;
  }
  const textById = new Map(
    state.accepted
      ? doneCriteria(state.accepted.content).map((row) => [row.id, row.text])
      : [],
  );
  const current = readFileSync(join(cwd, specPath), "utf8");
  const lines = [specPath, `Status: ${phaseLabel(state)}`];
  if (state.accepted && hashSpec(current) !== state.accepted.hash) {
    lines.push("Warning: the Spec file changed since acceptance.");
  }
  for (const [id, item] of state.criteria) {
    const label = `${id}: ${textById.get(id) ?? ""}`.trimEnd();
    if (item.state === "checked") {
      lines.push(`- [x] ${label}`, `  Evidence: ${item.evidence}`);
    } else if (item.state === "blocked") {
      lines.push(`- [!] ${label}`, `  Blocked: ${item.reason}`);
    } else {
      lines.push(`- [ ] ${label}`);
    }
  }
  for (const blocker of state.blockers) {
    lines.push(`Blocker: ${blocker}`);
  }
  return lines.join("\n");
}
