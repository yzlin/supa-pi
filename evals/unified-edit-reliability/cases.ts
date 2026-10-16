/** Natural-language edit cases scored on exact final file trees. */

export interface EditCase {
  id: string;
  prompt: string;
  files: Record<string, string>;
  expected: Record<string, string>;
  /** First-attempt success requires at least one edit call. */
  requiresEdit: boolean;
}

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;

const greek = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
] as const;

const serverPy = lines(
  "import logging",
  "",
  'DEFAULT_HOST = "127.0.0.1"',
  "DEFAULT_PORT = 8000",
  "",
  "",
  "def build_app():",
  "    app = {}",
  '    app["routes"] = []',
  "    return app",
  "",
  "",
  "def add_route(app, path):",
  '    app["routes"].append(path)',
  "",
  "",
  "def describe(app):",
  "    return f\"{len(app['routes'])} routes\"",
  "",
  "",
  "def serve(app):",
  '    logging.info("starting server")',
  "    return (DEFAULT_HOST, DEFAULT_PORT)",
);

export const CASES: EditCase[] = [
  {
    id: "01-single-line",
    requiresEdit: true,
    prompt: "In config.ts, change PORT from 3000 to 8080.",
    files: {
      "config.ts": lines(
        'export const HOST = "localhost";',
        "export const PORT = 3000;",
        "export const DEBUG = false;",
      ),
    },
    expected: {
      "config.ts": lines(
        'export const HOST = "localhost";',
        "export const PORT = 8080;",
        "export const DEBUG = false;",
      ),
    },
  },
  {
    id: "02-multi-line",
    requiresEdit: true,
    prompt:
      "In math.ts, replace the entire body of `sum` (the for loop and its accumulator) with the single statement `  return values.reduce((total, value) => total + value, 0);`. Keep the function signature and closing brace.",
    files: {
      "math.ts": lines(
        "export function sum(values: number[]): number {",
        "  let total = 0;",
        "  for (const value of values) {",
        "    total += value;",
        "  }",
        "  return total;",
        "}",
        "",
        "export function double(value: number): number {",
        "  return value * 2;",
        "}",
      ),
    },
    expected: {
      "math.ts": lines(
        "export function sum(values: number[]): number {",
        "  return values.reduce((total, value) => total + value, 0);",
        "}",
        "",
        "export function double(value: number): number {",
        "  return value * 2;",
        "}",
      ),
    },
  },
  {
    id: "03-insert-before-line",
    requiresEdit: true,
    prompt:
      "In list.txt, insert a new line `INSERTED` before line 4 (1-based), so it becomes the new line 4.",
    files: { "list.txt": lines(...greek) },
    expected: {
      "list.txt": lines(...greek.slice(0, 3), "INSERTED", ...greek.slice(3)),
    },
  },
  {
    id: "04-insert-after-line",
    requiresEdit: true,
    prompt: "In list.txt, insert a new line `INSERTED` after line 5 (1-based).",
    files: { "list.txt": lines(...greek) },
    expected: {
      "list.txt": lines(...greek.slice(0, 5), "INSERTED", ...greek.slice(5)),
    },
  },
  {
    id: "05-insert-before-anchor",
    requiresEdit: true,
    prompt:
      "In main.ts, insert the comment line `// Entry point.` immediately before the line `export function main(): void {`.",
    files: {
      "main.ts": lines(
        'import { run } from "./run";',
        "",
        "export function main(): void {",
        "  run();",
        "}",
      ),
    },
    expected: {
      "main.ts": lines(
        'import { run } from "./run";',
        "",
        "// Entry point.",
        "export function main(): void {",
        "  run();",
        "}",
      ),
    },
  },
  {
    id: "06-insert-after-anchor",
    requiresEdit: true,
    prompt:
      "In options.ts, add the property line `  timeout: 30,` immediately after the line `  retries: 3,`.",
    files: {
      "options.ts": lines(
        "export const options = {",
        '  name: "client",',
        "  retries: 3,",
        "  verbose: false,",
        "};",
      ),
    },
    expected: {
      "options.ts": lines(
        "export const options = {",
        '  name: "client",',
        "  retries: 3,",
        "  timeout: 30,",
        "  verbose: false,",
        "};",
      ),
    },
  },
  {
    id: "07-append",
    requiresEdit: true,
    prompt:
      "Append the line `- Fix login redirect.` to the end of CHANGES.md as a new last line.",
    files: {
      "CHANGES.md": lines("# Changes", "", "- Add search.", "- Speed up sync."),
    },
    expected: {
      "CHANGES.md": lines(
        "# Changes",
        "",
        "- Add search.",
        "- Speed up sync.",
        "- Fix login redirect.",
      ),
    },
  },
  {
    id: "08-delete-line",
    requiresEdit: true,
    prompt: "In list.txt, delete line 5 (1-based). Change nothing else.",
    files: { "list.txt": lines(...greek) },
    expected: {
      "list.txt": lines(...greek.slice(0, 4), ...greek.slice(5)),
    },
  },
  {
    id: "09-delete-range",
    requiresEdit: true,
    prompt:
      "In list.txt, delete lines 3 through 6 inclusive (1-based). Change nothing else.",
    files: { "list.txt": lines(...greek) },
    expected: {
      "list.txt": lines(...greek.slice(0, 2), ...greek.slice(6)),
    },
  },
  {
    id: "10-two-ops-one-file",
    requiresEdit: true,
    prompt:
      "In limits.ts, make two changes: change MAX_USERS from 10 to 50, and add a new last line `export const MAX_TEAMS = 5;`.",
    files: {
      "limits.ts": lines(
        "export const MAX_USERS = 10;",
        "export const MAX_PROJECTS = 20;",
      ),
    },
    expected: {
      "limits.ts": lines(
        "export const MAX_USERS = 50;",
        "export const MAX_PROJECTS = 20;",
        "export const MAX_TEAMS = 5;",
      ),
    },
  },
  {
    id: "11-two-files",
    requiresEdit: true,
    prompt:
      'Bump the version from 1.2.3 to 1.3.0 in both package.json (the "version" field) and VERSION.',
    files: {
      "package.json": lines(
        "{",
        '  "name": "demo",',
        '  "version": "1.2.3",',
        '  "private": true',
        "}",
      ),
      VERSION: lines("1.2.3"),
    },
    expected: {
      "package.json": lines(
        "{",
        '  "name": "demo",',
        '  "version": "1.3.0",',
        '  "private": true',
        "}",
      ),
      VERSION: lines("1.3.0"),
    },
  },
  {
    id: "12-literal-markers",
    requiresEdit: true,
    prompt:
      "In notes.md, change the line `  - item two` to `  - item 2` (keep its two-space indent), and change the line `+ plus item` to `+ plus item (done)`. Change nothing else.",
    files: {
      "notes.md": lines(
        "@owner review",
        "- item one",
        "  - item two",
        "+ plus item",
        "-- dashed",
      ),
    },
    expected: {
      "notes.md": lines(
        "@owner review",
        "- item one",
        "  - item 2",
        "+ plus item (done)",
        "-- dashed",
      ),
    },
  },
  {
    id: "13-bom-crlf-quotes",
    requiresEdit: true,
    prompt:
      "In greeting.txt, change the word world to team on the greeting line. Preserve everything else exactly, including the file's encoding marker, line endings, and typographic quotes and dash.",
    files: {
      "greeting.txt":
        "\uFEFFheader\r\nHello \u201Cworld\u201D \u2014 friend\r\nfooter\r\n",
    },
    expected: {
      "greeting.txt":
        "\uFEFFheader\r\nHello \u201Cteam\u201D \u2014 friend\r\nfooter\r\n",
    },
  },
  {
    id: "14-repeated-match",
    requiresEdit: true,
    prompt:
      "In handlers.py, inside the function `second` only, change `return compute(x)` to `return compute(x) + 1`. The function `first` must stay unchanged.",
    files: {
      "handlers.py": lines(
        "def first(x):",
        "    x = x + 1",
        "    return compute(x)",
        "",
        "",
        "def second(x):",
        "    x = x + 1",
        "    return compute(x)",
      ),
    },
    expected: {
      "handlers.py": lines(
        "def first(x):",
        "    x = x + 1",
        "    return compute(x)",
        "",
        "",
        "def second(x):",
        "    x = x + 1",
        "    return compute(x) + 1",
      ),
    },
  },
  {
    id: "15-no-op",
    requiresEdit: false,
    prompt:
      "Make sure the first line of README.md is exactly `# Project`. If it already is, leave the file unchanged.",
    files: { "README.md": lines("# Project", "", "Some text.") },
    expected: { "README.md": lines("# Project", "", "Some text.") },
  },
  {
    id: "16-two-hunks",
    requiresEdit: true,
    prompt:
      'In server.py, change DEFAULT_HOST to "0.0.0.0", and change the log message "starting server" to "server starting". Change nothing else.',
    files: { "server.py": serverPy },
    expected: {
      "server.py": serverPy
        .replace('"127.0.0.1"', '"0.0.0.0"')
        .replace('"starting server"', '"server starting"'),
    },
  },
  {
    id: "17-create-file",
    requiresEdit: false,
    prompt:
      "Create a new file docs/usage.md whose content is exactly these three lines:\n# Usage\n\nRun `demo --help`.",
    files: { "README.md": lines("# Demo") },
    expected: {
      "README.md": lines("# Demo"),
      "docs/usage.md": lines("# Usage", "", "Run `demo --help`."),
    },
  },
  {
    id: "18-create-and-edit",
    requiresEdit: true,
    prompt:
      'Create src/math.ts containing exactly the single line `export const square = (n: number): number => n * n;`, and add the line `export * from "./math";` as a new last line of src/index.ts.',
    files: { "src/index.ts": lines('export * from "./strings";') },
    expected: {
      "src/index.ts": lines(
        'export * from "./strings";',
        'export * from "./math";',
      ),
      "src/math.ts": lines(
        "export const square = (n: number): number => n * n;",
      ),
    },
  },
];
