import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { TO_SPEC_RESERVED_WORDS } from "./constants";
import { isLedgerComplete, MAX_REPAIRS } from "./ledger";
import type { ExecutionLedger, SpecResume } from "./schema";

export const SPECS_DIR = ".pi/specs";
export const SPEC_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const INTERRUPTED_BLOCKER =
  "Interrupted in a prior session; repair required";

const text = Type.String({ minLength: 1 });
const texts = Type.Array(text);
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const common = { ts: Type.String({ format: "date-time" }) };
const lineage = {
  assignment: text,
  lineageId: text,
  repairCount: Type.Integer({ minimum: 0 }),
  priorRepairs: Type.Integer({ minimum: 0 }),
};
const options = { additionalProperties: false };
// Done Criterion fields are optional only so pre-gate done logs still parse
// (persisted-state reason). Remove when no pre-gate log remains under .pi/specs/.
const criteria = Type.Optional(texts);
export const SpecLogEventSchema = Type.Union([
  Type.Object(
    {
      ...common,
      event: Type.Literal("accepted"),
      hash,
      invocationId: text,
      criteria,
      assignments: Type.Array(
        Type.Object({ id: text, dependencies: texts, criteria }, options),
      ),
    },
    options,
  ),
  Type.Object(
    { ...common, event: Type.Literal("revised"), hash, previousHash: hash },
    options,
  ),
  Type.Object(
    {
      ...common,
      event: Type.Literal("started"),
      assignment: text,
      lineageId: text,
      attemptId: text,
    },
    options,
  ),
  Type.Object(
    {
      ...common,
      ...lineage,
      event: Type.Literal("verified"),
      resumed: Type.Boolean(),
      evidence: texts,
      criteria: Type.Optional(
        Type.Array(Type.Object({ id: text, evidence: text }, options)),
      ),
      head: Type.Union([text, Type.Null()]),
      snapshot: Type.Union([text, Type.Null()]),
      snapshotError: Type.Optional(text),
    },
    options,
  ),
  Type.Object(
    { ...common, ...lineage, event: Type.Literal("blocked"), blockers: texts },
    options,
  ),
  Type.Object(
    { ...common, ...lineage, event: Type.Literal("repaired"), from: text },
    options,
  ),
  Type.Object(
    { ...common, event: Type.Literal("stopped"), reason: text },
    options,
  ),
  Type.Object({ ...common, event: Type.Literal("done") }, options),
  Type.Object(
    {
      ...common,
      event: Type.Literal("reviewed"),
      hash,
      round: Type.Integer({ minimum: 1 }),
      trigger: Type.Union([
        Type.Object(
          {
            source: Type.Literal("classifier"),
            probability: Type.Number({ minimum: 0, maximum: 1 }),
            model: Type.String({ pattern: "^[^/\\s]+/\\S+$" }),
          },
          options,
        ),
        Type.Object(
          {
            source: Type.Literal("fallback"),
            dcCount: Type.Integer({ minimum: 0 }),
            reason: text,
          },
          options,
        ),
      ]),
      decision: Type.Union([
        Type.Literal("accept"),
        Type.Literal("revise"),
        Type.Literal("stop"),
      ]),
      // id is `<reviewer slot>:<question id>`; question ids are report-scoped.
      answers: Type.Array(
        Type.Object(
          { id: text, focus: text, question: text, answer: text },
          options,
        ),
      ),
      findings: Type.Integer({ minimum: 0 }),
      // Reviewed Spec text, so a later round can show the revision diff.
      // Optional only so pre-diff logs still parse (persisted-state reason).
      // Remove the Optional when no pre-diff log remains under .pi/specs/.
      content: Type.Optional(Type.String()),
    },
    options,
  ),
]);
export type SpecLogEvent = Static<typeof SpecLogEventSchema>;

export function validSlug(slug: string): boolean {
  return (
    slug.length <= 48 &&
    SPEC_SLUG_PATTERN.test(slug) &&
    !TO_SPEC_RESERVED_WORDS.includes(slug)
  );
}

export function parseSpecPath(specPath: string): {
  slug: string;
  specPath: string;
  logPath: string;
} {
  const prefix = `${SPECS_DIR}/`;
  const slug = specPath.slice(prefix.length, -3);
  if (!validSlug(slug) || specPath !== `${prefix}${slug}.md`) {
    throw new Error(`Invalid Spec path: ${specPath}`);
  }
  return { slug, specPath, logPath: `${prefix}${slug}.log.jsonl` };
}

export function hashSpec(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// Each top-level line in `## Done Criteria` is a row `- DC-n: <criterion>`;
// indented lines continue the previous row.
export function parseDoneCriteria(content: string): string[] {
  const lines = content.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^## Done Criteria\s*$/u.test(line));
  if (start === -1) {
    throw new Error("Spec has no ## Done Criteria section");
  }
  const ids: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /u.test(line)) {
      break;
    }
    if (!line.trim() || /^\s/u.test(line)) {
      continue;
    }
    const id = /^- (DC-[1-9][0-9]*): \S/u.exec(line)?.[1];
    if (!id) {
      throw new Error(`Done Criteria row lacks a DC-n: label: ${line}`);
    }
    if (ids.includes(id)) {
      throw new Error(`Repeated Done Criterion label: ${id}`);
    }
    ids.push(id);
  }
  if (!ids.length) {
    throw new Error("Spec ## Done Criteria section has no rows");
  }
  return ids;
}

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
  const events: SpecLogEvent[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    try {
      const event: unknown = JSON.parse(line);
      if (
        !Value.Check(SpecLogEventSchema, event) ||
        (!isSpecAccepted(events) &&
          event.event !== "accepted" &&
          event.event !== "reviewed")
      ) {
        throw new Error("Invalid event");
      }
      events.push(event);
    } catch {
      throw new Error(`Corrupt Spec log ${absLogPath}:${index + 1}`);
    }
  }
  return events;
}

// Reviewed events may precede acceptance; only an accepted event accepts.
export function isSpecAccepted(events: SpecLogEvent[]): boolean {
  return events.some((event) => event.event === "accepted");
}

export function reviewState(
  events: SpecLogEvent[],
  currentHash: string,
): {
  approved: boolean;
  latestDecision:
    | Extract<SpecLogEvent, { event: "reviewed" }>["decision"]
    | null;
  reviewedHashes: number;
} {
  const reviewed = events.flatMap((event) =>
    event.event === "reviewed" ? [event] : [],
  );
  // Latest by log order; a later stop/revise overrides an earlier accept.
  const latestDecision =
    reviewed.findLast((event) => event.hash === currentHash)?.decision ?? null;
  return {
    approved: latestDecision === "accept",
    latestDecision,
    reviewedHashes: new Set(reviewed.map((event) => event.hash)).size,
  };
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

interface LineageStatus {
  assignment: string;
  state: "pending" | "started" | "verified" | "blocked" | "repaired";
  repairs: number;
  blockers: string[];
}

function lineageStatuses(events: SpecLogEvent[]): Map<string, LineageStatus> {
  const lineages = new Map<string, LineageStatus>();
  for (const event of events) {
    if (event.event === "accepted") {
      for (const assignment of event.assignments) {
        if (!lineages.has(assignment.id)) {
          lineages.set(assignment.id, {
            assignment: assignment.id,
            state: "pending",
            repairs: 0,
            blockers: [],
          });
        }
      }
    } else if ("lineageId" in event) {
      const previous = lineages.get(event.lineageId);
      const repairs =
        "repairCount" in event ? event.repairCount + event.priorRepairs : 0;
      lineages.set(event.lineageId, {
        assignment: event.assignment,
        state: event.event,
        repairs: Math.max(previous?.repairs ?? 0, repairs),
        blockers: event.event === "blocked" ? [...event.blockers] : [],
      });
    }
  }
  return lineages;
}

export function deriveSpecResume(events: SpecLogEvent[]): {
  hash: string | null;
  resume: SpecResume | null;
  done: boolean;
} {
  let currentHash: string | null = null;
  let planned = new Set<string>();
  for (const event of events) {
    if (event.event === "accepted" || event.event === "revised") {
      currentHash = event.hash;
    }
    if (event.event === "accepted") {
      planned = new Set(event.assignments.map((item) => item.id));
    }
  }
  // Only lineages in the latest accepted plan resume; revisions may drop others.
  const lineages = [...lineageStatuses(events)].filter(([id]) =>
    planned.has(id),
  );
  return {
    hash: currentHash,
    resume: isSpecAccepted(events)
      ? {
          verified: lineages
            .filter(([, status]) => status.state === "verified")
            .map(([id]) => id),
          // Unverified progress must go through repair and its budget check.
          blocked: Object.fromEntries(
            lineages
              .filter(
                ([, status]) => !["pending", "verified"].includes(status.state),
              )
              .map(([id, status]) => [
                id,
                status.state === "blocked"
                  ? status.blockers
                  : [INTERRUPTED_BLOCKER],
              ]),
          ),
          priorRepairs: Object.fromEntries(
            lineages
              .filter(([, status]) => status.repairs > 0)
              .map(([id, status]) => [id, status.repairs]),
          ),
        }
      : null,
    done: events.at(-1)?.event === "done",
  };
}

export type CriterionState = "passed" | "pending" | "unmet";

// Derives each Done Criterion's state from the latest accepted plan. Only
// verification after that acceptance counts; earlier evidence is history.
export function deriveCriteriaStates(
  events: SpecLogEvent[],
): { id: string; state: CriterionState }[] {
  let start = -1;
  for (let index = 0; index < events.length; index++) {
    if (events[index]?.event === "accepted") {
      start = index;
    }
  }
  const accepted = events[start];
  if (accepted?.event !== "accepted" || !accepted.criteria) {
    return [];
  }
  const proved = new Map<string, Set<string>>();
  const terminal = new Set<string>();
  let stopped = false;
  for (const event of events.slice(start + 1)) {
    if (event.event === "stopped") {
      stopped = true;
    } else if ("lineageId" in event) {
      proved.set(
        event.lineageId,
        new Set(
          event.event === "verified"
            ? (event.criteria ?? []).map((item) => item.id)
            : [],
        ),
      );
      if (
        event.event === "blocked" &&
        event.repairCount + event.priorRepairs >= MAX_REPAIRS
      ) {
        terminal.add(event.lineageId);
      } else {
        terminal.delete(event.lineageId);
      }
    }
  }
  return accepted.criteria.map((id) => {
    const open = accepted.assignments
      .filter((item) => item.criteria?.includes(id))
      .filter((item) => !proved.get(item.id)?.has(id));
    let state: CriterionState = "pending";
    if (!open.length) {
      state = "passed";
    } else if (stopped || open.every((item) => terminal.has(item.id))) {
      state = "unmet";
    }
    return { id, state };
  });
}

export function specEventsFromTransition(
  prev: ExecutionLedger | null,
  next: ExecutionLedger,
  ts: string,
): SpecLogEvent[] {
  if (!next.specPath) {
    return [];
  }
  const baseline =
    prev?.plan === next.plan && prev.specPath === next.specPath ? prev : null;
  const previous = new Map(
    baseline?.assignments.map((item) => [item.id, item]),
  );
  const events: SpecLogEvent[] = [];
  for (const item of next.assignments) {
    const old = previous.get(item.id);
    const lineageFields = {
      ts,
      assignment: item.id,
      lineageId: item.lineageId,
      repairCount: item.repairCount,
      priorRepairs: item.priorRepairs ?? 0,
    };
    if (!old && item.repairCount > 0) {
      const predecessor = next.assignments.find(
        (parent) => parent.supersededBy === item.id,
      );
      if (!predecessor) {
        throw new Error(`Repair predecessor missing: ${item.id}`);
      }
      events.push({
        ...lineageFields,
        event: "repaired",
        from: predecessor.id,
      });
    }
    if (old?.status === item.status) {
      continue;
    }
    if (item.status === "running") {
      if (!item.attemptId) {
        throw new Error(`Running attempt missing: ${item.id}`);
      }
      events.push({
        event: "started",
        ts,
        assignment: item.id,
        lineageId: item.lineageId,
        attemptId: item.attemptId,
      });
    } else if (item.status === "completed") {
      events.push({
        ...lineageFields,
        event: "verified",
        resumed: item.resumed ?? false,
        evidence: [...item.evidence],
        ...(item.criteriaEvidence
          ? { criteria: structuredClone(item.criteriaEvidence) }
          : {}),
        head: null,
        snapshot: null,
      });
    } else if (item.status === "blocked") {
      events.push({
        ...lineageFields,
        event: "blocked",
        blockers: [...item.blockers],
      });
    }
  }
  if (
    next.plan &&
    (!baseline || !isLedgerComplete(baseline)) &&
    isLedgerComplete(next)
  ) {
    events.push({ event: "done", ts });
  }
  return events;
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

function specStatus(events: SpecLogEvent[]): string {
  const last = events.at(-1)?.event ?? "ready";
  return last === "reviewed" && !isSpecAccepted(events)
    ? "reviewed (not accepted)"
    : last;
}

export function renderSpecStatus(cwd: string, slug?: string): string {
  if (slug === undefined) {
    const directory = join(cwd, SPECS_DIR);
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
        let status: string;
        try {
          status = specStatus(
            readSpecLog(join(directory, `${name}.log.jsonl`)),
          );
        } catch {
          status = "corrupt";
        }
        return `${name}  ${status}`;
      })
      .join("\n");
  }
  if (!validSlug(slug)) {
    return `Invalid Spec slug: ${slug}. Use 1–48 lowercase letters, digits or hyphens, starting with a letter or digit; status and classifier are reserved.`;
  }
  const { specPath, logPath } = parseSpecPath(`${SPECS_DIR}/${slug}.md`);
  if (!existsSync(join(cwd, specPath))) {
    return `Spec not found: ${specPath}`;
  }
  let events: SpecLogEvent[];
  try {
    events = readSpecLog(join(cwd, logPath));
  } catch (error) {
    return `${specPath}\nStatus: corrupt\n${error instanceof Error ? error.message : String(error)}`;
  }
  const current = deriveSpecResume(events);
  const rows = [...lineageStatuses(events)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([id, status]) =>
        `${id} | ${status.assignment} | ${status.state} | ${status.repairs}`,
    );
  const criteriaRows = deriveCriteriaStates(events).map(
    ({ id, state }) => `${id} | ${state}`,
  );
  return [
    specPath,
    `Status: ${specStatus(events)}`,
    `Hash: ${current.hash ?? "none"}`,
    `Events: ${events.length}`,
    `Last event: ${events.at(-1)?.ts ?? "none"}`,
    "",
    "lineage | latest assignment | state | repairs used",
    ...rows,
    ...(criteriaRows.length ? ["", "criterion | state", ...criteriaRows] : []),
  ].join("\n");
}
