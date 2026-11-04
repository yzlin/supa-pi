// Paired old-vs-new path cases. Each case seeds a tiny git repo, sends one
// command through `pi --mode rpc`, and is scored offline from the workspace,
// session files, and child run directories. Keep cases small: every run spends
// real model calls in the main session and its children.

export type Arm = "old" | "new";

export interface Fixture {
  files: Record<string, string>;
  /** Files written after the seed commit, left uncommitted (review targets). */
  dirty?: Record<string, string>;
}

export interface Check {
  id: string;
  description: string;
}

export interface PairedCase {
  id: string;
  kind: "execute" | "review";
  description: string;
  fixture: Fixture;
  /** The user message per arm; identical unless a command grammar differs. */
  prompt: Record<Arm, string>;
  /** Scripted replies to dialogs, matched in order against the request title/message. */
  dialogs: DialogRule[];
  checks: Check[];
}

export interface DialogRule {
  /** Case-insensitive substring of the dialog title or message. */
  match: string;
  /** For select: the option to pick (substring); for confirm: yes/no; for input/editor: text. */
  reply: string | boolean;
}

const PACKAGE = JSON.stringify(
  {
    name: "paired-fixture",
    private: true,
    type: "module",
    scripts: { test: "bun test" },
  },
  null,
  2,
);

const MATH_TS = `export function add(left: number, right: number): number {
  return left - right;
}

export function multiply(left: number, right: number): number {
  return left * right;
}
`;

const MATH_TEST = `import { expect, it } from "bun:test";
import { add, multiply } from "../src/math";

it("adds numbers", () => {
  expect(add(7, 5)).toBe(12);
});

it("multiplies numbers", () => {
  expect(multiply(7, 5)).toBe(35);
});
`;

const FORMAT_TS = `export function formatName(first: string, last: string): string {
  return [first, last].join(" ");
}
`;

const SPEC_SMALL = `# Execution Brief

## Execution Scope
Fix add() in src/math.ts and add a clamp() helper with tests. Only src/ and tests/ change.

## User Stories
- US-1: As a caller, I want add(7, 5) to return 12, so that sums are correct.
- US-2: As a caller, I want clamp(value, min, max), so that I can bound numbers.

## Plan
1. Fix add() in src/math.ts to return left + right.
2. Add clamp(value, min, max) to src/math.ts; values below min return min, above max return max.
3. Add tests for clamp in tests/math.test.ts.

## Done Criteria
- DC-1: add(7, 5) returns 12 and the existing math tests pass (US-1)
  Evidence: bun test tests/math.test.ts passes
- DC-2: clamp(5, 0, 3) is 3, clamp(-1, 0, 3) is 0, clamp(2, 0, 3) is 2, each covered by a test (US-2)
  Evidence: bun test tests/math.test.ts passes with clamp tests present

## Verification
Run bun test.

## Out of Scope
Other modules.
`;

const AUTH_TS = `export interface User {
  id: string;
  role: string;
}

export function canDeleteProject(user: User, ownerId: string): boolean {
  return user.role === "admin" || user.id === ownerId;
}
`;

const AUTH_DIRTY = `export interface User {
  id: string;
  role: string;
}

export function canDeleteProject(user: User, ownerId: string): boolean {
  if (process.env.DEBUG) {
    return true;
  }
  return user.role.includes("admin") || user.id == ownerId;
}

export function projectQuery(projectId: string): string {
  return "SELECT * FROM projects WHERE id = '" + projectId + "'";
}
`;

const SEARCH_TS = `export function topMatches(items: string[], query: string): string[] {
  return items.filter((item) => item.includes(query)).slice(0, 10);
}
`;

const SEARCH_CLEAN = `export function topMatches(
  items: readonly string[],
  query: string,
  limit = 10,
): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  return items
    .filter((item) => item.toLowerCase().includes(needle))
    .slice(0, limit);
}
`;

const SEARCH_TEST = `import { expect, it } from "bun:test";
import { topMatches } from "../src/search";

it("matches case-insensitively and honors the limit", () => {
  expect(topMatches(["Alpha", "beta", "alphabet"], "ALPHA", 1)).toEqual(["Alpha"]);
});

it("returns nothing for a blank query", () => {
  expect(topMatches(["a"], "  ")).toEqual([]);
});
`;

export const CASES: PairedCase[] = [
  {
    id: "execute-spec-small",
    kind: "execute",
    description:
      "Execute a two-criterion Spec; main must verify each criterion itself and log it.",
    fixture: {
      files: {
        "package.json": PACKAGE,
        "src/math.ts": MATH_TS,
        "tests/math.test.ts": MATH_TEST,
        ".pi/specs/math-fix.md": SPEC_SMALL,
      },
    },
    prompt: {
      old: "/execute @.pi/specs/math-fix.md",
      new: "/execute @.pi/specs/math-fix.md",
    },
    dialogs: [{ match: "", reply: true }],
    checks: [
      { id: "tests-pass", description: "bun test exits 0 after the run" },
      { id: "clamp-correct", description: "hidden clamp probe passes" },
      {
        id: "scope",
        description: "only src/, tests/, and .pi/ changed",
      },
      {
        id: "log-done",
        description: "Spec log ends in done",
      },
      {
        id: "main-verified",
        description:
          "main ran a test command after the last edit (main or child)",
      },
    ],
  },
  {
    id: "execute-inline-plan",
    kind: "execute",
    description:
      "Execute an inline plan; the arm must persist a Spec, run it, and verify.",
    fixture: {
      files: {
        "package.json": PACKAGE,
        "src/format.ts": FORMAT_TS,
      },
    },
    prompt: {
      old: "/execute Make formatName in src/format.ts trim both parts and skip empty parts (formatName(' Ada ', '') === 'Ada'). Add tests/format.test.ts covering trimming and empty parts. Done when bun test passes.",
      new: "/execute Make formatName in src/format.ts trim both parts and skip empty parts (formatName(' Ada ', '') === 'Ada'). Add tests/format.test.ts covering trimming and empty parts. Done when bun test passes.",
    },
    dialogs: [{ match: "", reply: true }],
    checks: [
      { id: "tests-pass", description: "bun test exits 0 after the run" },
      { id: "format-correct", description: "hidden formatName probe passes" },
      { id: "scope", description: "only src/, tests/, and .pi/ changed" },
      {
        id: "log-done",
        description: "a Spec log exists and ends in done",
      },
      {
        id: "main-verified",
        description: "main ran a test command after the last edit",
      },
    ],
  },
  {
    id: "review-seeded-bugs",
    kind: "review",
    description:
      "Review an uncommitted diff with three seeded defects; report only.",
    fixture: {
      files: { "package.json": PACKAGE, "src/auth.ts": AUTH_TS },
      dirty: { "src/auth.ts": AUTH_DIRTY },
    },
    prompt: { old: "/review uncommitted", new: "/review uncommitted" },
    dialogs: [
      { match: "uncommitted", reply: "uncommitted" },
      { match: "", reply: true },
    ],
    checks: [
      {
        id: "finds-debug-bypass",
        description: "report names the DEBUG env bypass",
      },
      {
        id: "finds-role-substring",
        description: "report names the role.includes('admin') substring match",
      },
      {
        id: "finds-sql-injection",
        description: "report names SQL injection in projectQuery",
      },
      { id: "no-edits", description: "the working tree is unchanged" },
    ],
  },
  {
    id: "review-clean",
    kind: "review",
    description:
      "Review a clean, tested uncommitted change; expect no blocking findings.",
    fixture: {
      files: {
        "package.json": PACKAGE,
        "src/search.ts": SEARCH_TS,
      },
      dirty: {
        "src/search.ts": SEARCH_CLEAN,
        "tests/search.test.ts": SEARCH_TEST,
      },
    },
    prompt: { old: "/review uncommitted", new: "/review uncommitted" },
    dialogs: [
      { match: "uncommitted", reply: "uncommitted" },
      { match: "", reply: true },
    ],
    checks: [
      {
        id: "no-false-blocker",
        description:
          "report flags no critical/high/blocking defect in the change",
      },
      { id: "no-edits", description: "the working tree is unchanged" },
    ],
  },
];

/** Hidden probes written only at scoring time, so a run cannot see them. */
export const PROBES: Record<string, { path: string; content: string }> = {
  "clamp-correct": {
    path: "tests/__probe_clamp.test.ts",
    content: `import { expect, it } from "bun:test";
import * as math from "../src/math";
it("probe", () => {
  const clamp = (math as Record<string, unknown>).clamp as (v: number, a: number, b: number) => number;
  expect(clamp(5, 0, 3)).toBe(3);
  expect(clamp(-1, 0, 3)).toBe(0);
  expect(clamp(2, 0, 3)).toBe(2);
  expect(math.add(7, 5)).toBe(12);
});
`,
  },
  "format-correct": {
    path: "tests/__probe_format.test.ts",
    content: `import { expect, it } from "bun:test";
import { formatName } from "../src/format";
it("probe", () => {
  expect(formatName(" Ada ", "")).toBe("Ada");
  expect(formatName(" Ada ", " Lovelace ")).toBe("Ada Lovelace");
  expect(formatName("", " Lovelace")).toBe("Lovelace");
});
`,
  },
};
