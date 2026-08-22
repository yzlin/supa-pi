export interface TddToolCall {
  name: string;
  args: Record<string, unknown>;
  assistantTurn: number;
  startOrder: number;
  endOrder: number;
  isError: boolean;
  resultText?: string;
  /** True when the middle of a bash result was omitted from bounded capture. */
  resultTruncated?: boolean;
  mutationTargets?: string[];
  hasTestTargets?: boolean;
  hasProductionTargets?: boolean;
  mutationAmbiguous?: boolean;
  rustWriteContent?: "production" | "test" | "unavailable";
  editOldSnippet?: string;
  editNewSnippet?: string;
  editDeltaTruncated?: boolean;
  regressionIntent?: string[];
  regressionTitles?: string[];
  mutationDelta?: Array<{
    path: string;
    status: "changed" | "created" | "deleted";
  }>;
  /** True when pre/post proofs covered every expected coverage artifact target. */
  coverageArtifactProof?: boolean;
  /** True when a direct runner's relevant workspace snapshot was proven before and after. */
  runnerWorkspaceProof?: boolean;
  runnerWorkspaceDelta?: Array<{
    path: string;
    status: "changed" | "created" | "deleted";
  }>;
  /** True only when tool arguments or result metadata authoritatively prove a delta. */
  mutationProven?: boolean;
}

export interface TddEvidenceResult {
  status?: unknown;
  validation?: unknown;
  blockers?: unknown;
}

const MUTATION_TOOLS = new Set([
  "edit",
  "write",
  "apply_patch",
  "apply-patch",
  "applypatch",
]);
const UNAVAILABLE_MARKERS = [
  "not run",
  "not-run",
  "not executed",
  "unavailable",
  "unable to run",
  "unable to execute",
  "could not run",
  "could not execute",
  "wasn't run",
  "was not run",
];
const UNAVAILABLE_MARKERS_LONGEST_FIRST = [...UNAVAILABLE_MARKERS].sort(
  (left, right) => right.length - left.length
);
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_EXPANSION_START_PATTERN = /[({A-Za-z_0-9*#?@$!-]/;
const WHITESPACE_PATTERN = /\s/;
const TEST_SCRIPT_PATTERN = /^test(?::|$)/;
const PACKAGE_SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn"]);
const NO_TESTS_PATTERN =
  /no tests? (?:found|ran|collected)|\b0 tests?\b|did not find any tests?/i;
const INFRASTRUCTURE_FAILURE_PATTERN =
  /cannot find module|module not found|command not found|failed to (?:load|resolve)[^\n]*config|importerror|error during collection/i;
const GENERIC_COMPILATION_FAILURE_PATTERN = /syntax ?error|compilation failed/i;
const HARD_SETUP_FAILURE_PATTERN =
  /command not found|failed to load[^\n]*config|error during collection/i;
const MISSING_FILE_FAILURE_PATTERN = /\b(?:enoent|no such file)\b/i;
const TARGET_MISSING_REFERENCE_PATTERNS = [
  /no matching export in [^\n]+ for import ["']([^"'\n]+)["']/i,
  /requested module [^\n]+ does not provide an export named ["']([^"'\n]+)["']/i,
  /export named ["']([^"'\n]+)["'] not found in module/i,
  /module ["'][^"'\n]+["'] has no exported member ["']([^"'\n]+)["']/i,
  /(?:referenceerror:\s*)?([A-Za-z_$][\w$]*) is not defined/i,
  /cannot find module ["']([^"'\n]+)["']/i,
  /module not found[^\n]*["']([^"'\n]+)["']/i,
  /failed to resolve import ["']([^"'\n]+)["']/i,
] as const;
const PASS_LINE_PATTERN = /(?:^|\n)\s*(?:PASS|ok)\b/;
const FAIL_LINE_PATTERN = /(?:^|\n)\s*(?:FAIL|not ok)\b/;
const RED_CLAIM_PATTERN = /\b(?:fail|fails|failed|failing|failure)\b/;
const GREEN_CLAIM_PATTERN =
  /\b(?:pass|passes|passed|passing|success|successful|succeeded)\b/;
const COVERAGE_CLAIM_PATTERN =
  /\b(?:covered|measured|reported|\d+(?:\.\d+)?%)\b/;
const TOOLING_PATTERN = /\btool(?:ing)?\b/;
const BECAUSE_PATTERN = /\bbecause\b/;
const SWIFT_TEST_PASS_PATTERN =
  /(?:test suite .* passed|test run with \d+ tests? passed)/i;
const SWIFT_TEST_FAIL_PATTERN =
  /(?:test suite .* failed|executed \d+ tests?, with [1-9]\d* failures?)/i;
const GRADLE_TEST_COUNT_PATTERN = /\b[1-9]\d* tests? completed\b/i;
const GRADLE_EXECUTED_TEST_TASK_PATTERN =
  /^>\s*Task\s+(?::[^:\s]+)*:test\s*$/im;
const GRADLE_FAILED_TEST_TASK_PATTERN =
  /^>\s*Task\s+(?::[^:\s]+)*:test\s+FAILED\s*$/im;
const GRADLE_BUILD_SUCCESS_PATTERN = /\bbuild successful\b/i;
const GRADLE_BUILD_FAILURE_PATTERN = /\bbuild failed\b/i;
const MAVEN_TEST_SUMMARY_PATTERN =
  /tests run:\s*([1-9]\d*)[^\n]*failures:\s*(\d+)[^\n]*errors:\s*(\d+)/i;
const DOTNET_TEST_SUMMARY_PATTERN =
  /failed:\s*(\d+)[^\n]*passed:\s*(\d+)[^\n]*total:\s*([1-9]\d*)/i;
const COVERAGE_PERCENT_PATTERN =
  /\b(statements?|branches?|functions?|lines?)\s*[:=]\s*(\d+(?:\.\d+)?)%|\b(\d+(?:\.\d+)?)%\s+(statements?|branches?|functions?|lines?)\b/gi;
const COVERAGE_COUNT_PATTERN =
  /\b(?:measured|reported|observed)\s+(\d+(?:\.\d+)?)\s+(statements?|branches?|functions?|lines?)|\b(statements?|branches?|functions?|lines?)\s*[:=]\s*(\d+(?:\.\d+)?)\b(?!\s*%)/gi;
const COVERAGE_RATIO_PATTERN =
  /\b(\d+(?:\.\d+)?)\s*(?:of|\/)\s*(\d+(?:\.\d+)?)\s+(statements?|branches?|functions?|lines?)\s+(?:covered|measured|reported|observed)\b/gi;
const COVERAGE_THRESHOLD_PATTERN =
  /\b(?:coverage\s+)?threshold(?:\s+of)?\s+(\d+(?:\.\d+)?)%?\s+(met|passed)\b/gi;
const NUMERIC_COVERAGE_CLAIM_PATTERN =
  /\b(?:statements?|branches?|functions?|lines?)\s*[:=]\s*\d|\b\d+(?:\.\d+)?%\s+(?:statements?|branches?|functions?|lines?)|\b\d+(?:\.\d+)?\s*(?:of|\/)\s*\d+(?:\.\d+)?\s+(?:statements?|branches?|functions?|lines?)|\b(?:coverage\s+)?threshold\b/i;
const NEGATIVE_COVERAGE_PATTERN =
  /\b(?:failed|failing|unmet|below|under|missed)\b|\bthreshold\b[^\n]*(?:not met|not passed)|\bexit(?:ed)?(?:\s+with)?(?:\s+code)?\s+[1-9]\d*\b/i;
const COVERAGE_KIND_PATTERN =
  /\b(?:behavio[u]?r|failure|error|regression|edge|branch|path|case|scenario|test)\b/;
const COVERAGE_ACTION_PATTERN =
  /\b(?:covered|tested|exercised|verified|passed|succeeded)\b/;
const NAMED_EVIDENCE_PATTERN =
  /(?:`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\b[A-Za-z_$][\w$]*\([^\n)]*\)|\b[\w.-]+(?:[/.-][\w.-]+)+\b)/;
const TEST_COMMAND_RESULT_PATTERN =
  /\b(?:bun|npm|pnpm|yarn|deno|cargo|go|pytest|py\.test|jest|vitest|mocha|ava)\b[^\n]*\b(?:pass(?:ed|es|ing)?|succeeded|\d+\s+(?:tests?\s+)?pass)/;
const PASS_COUNT_PATTERN = /(\d+)\s+(?:tests?\s+)?pass(?:ed|s|ures?|ing)?\b/gi;
const FAIL_COUNT_PATTERN = /(\d+)\s+(?:tests?\s+)?fail(?:ed|s|ures?|ing)?\b/gi;
const RUST_SOURCE_PATH_PATTERN = /\.rs$/i;
const RUST_INLINE_TEST_MARKER_PATTERN =
  /^\s*#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/i;
const RUST_INLINE_TEST_MARKER_ANYWHERE_PATTERN =
  /(?:^|\n)\s*#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/i;
const RUST_CFG_TEST_MODULE_PATTERN =
  /^(?:pub(?:\([^)]*\))?\s+)?mod\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/;
const COVERAGE_REPORT_WRITE_PATTERN = /^(?:html|xml|json|lcov)(?::|$)/;
const WINDOWS_NON_RELATIVE_PATH_PATTERN = /^(?:[A-Za-z]:|[/\\]{2})/;
const PATCH_BEGIN_PATTERN = /^\*\*\* Begin Patch\s*$/m;
const PATCH_END_PATTERN = /^\*\*\* End Patch\s*$/m;
const PATCH_LINE_SPLIT_PATTERN = /\r?\n/;
const PATCH_OPERATION_PATTERN = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE_PATTERN = /^\*\*\* Move to: (.+)$/;
const UNIFIED_PATCH_PATH_PATTERN = /^[ab]\//;
const REPORTER_OUTPUT_PATTERN = /(?:^|[,=])(?:output|file|destination)=/;
const REASON_SEPARATOR_PATTERN = /[\s:;,.-]+/g;
const REASON_CONNECTOR_PATTERN = /\b(?:and|or|because|since|as)\b/g;
const INTENT_PATH_SEPARATOR_PATTERN = /[/.:-]/;
const LEADING_DOT_SLASH_PATTERN = /^\.\//;
const TEST_FILE_SUFFIX_PATTERN = /\.(?:test|spec|case)?\.[^.]+$/i;
const INTENT_STOP_WORDS = new Set([
  "assert",
  "assertion",
  "behavior",
  "bun",
  "case",
  "coverage",
  "error",
  "expected",
  "fail",
  "failed",
  "failure",
  "green",
  "npm",
  "pass",
  "passed",
  "path",
  "pnpm",
  "red",
  "regression",
  "run",
  "spec",
  "src",
  "test",
  "tests",
  "true",
  "unit",
  "false",
  "yarn",
]);
const MAX_MUTATION_TARGETS = 100;
const MAX_MUTATION_PATH_BYTES = 500;
const MAX_EDIT_SNIPPET_BYTES = 2000;
const MAX_METADATA_SCAN_BYTES = 16_000;
const MAX_METADATA_SCAN_SEGMENTS = 8;
const MAX_REGRESSION_INTENT_ITEMS = 50;
const MAX_REGRESSION_INTENT_BYTES = 100;
const IN_SOURCE_TEST_PATH_PATTERN = /\.(?:[cm]?[jt]sx?|py)$/i;
const VITEST_TEST_FORM_PATTERN = /^(?:describe|it|test)\s*\(/;
const PYTHON_DOCTEST_FORM_PATTERN = /^>>>\s+\S/;
const PYTHON_DOCTEST_OUTPUT_PATTERN =
  /^(?:Traceback \(most recent call last\):.*|\s*(?:[A-Za-z_$][\w$.]*(?:Error|Exception):|[-+]?\d+(?:\.\d+)?|True|False|None|["'([{<]).*)$/;
const TRAILING_REPLACEMENT_CHARACTER_PATTERN = /\uFFFD$/;
const DIGITS_ONLY_PATTERN = /^\d+$/;
const BUN_ARTIFACT_COVERAGE_REPORTER_PATTERN = /^(?:lcov|html|json)(?::|$)/;
const PYTEST_TEXT_COVERAGE_REPORT_PATTERN = /^(?:term|term-missing)(?::|$)/;
const JS_TEST_TITLE_PATTERN =
  /\b(describe|it|test)\s*\(\s*["'`]([^"'`\n]+)["'`]/g;
const FUNCTION_TEST_TITLE_PATTERN =
  /\b(?:async\s+)?(?:def|fn)\s+(test[_A-Za-z0-9]+)\b/g;
const GO_TEST_TITLE_PATTERN = /\bfunc\s+(Test[A-Za-z0-9_]+)\b/g;
const GHERKIN_SCENARIO_PATTERN = /^\s*Scenario(?: Outline)?:\s*(.+)$/gim;

const HYPOTHETICAL_MARKERS = [
  "expected to",
  "should fail",
  "should pass",
  "would fail",
  "would pass",
  "predicted",
  "likely to fail",
  "likely to pass",
];

function scanShell(command: string): {
  tokens: string[];
  activeControl: boolean;
} {
  const tokens: string[] = [];
  let token = "";
  let quote: "single" | "double" | undefined;
  let activeControl = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "\\" && quote !== "single") {
      const next = command[index + 1];
      if (next !== undefined) {
        token += next;
        index += 1;
      }
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      continue;
    }
    if (quote === "single") {
      token += character;
      continue;
    }
    if (character === "`" || character === "\n") {
      activeControl = true;
    } else if (
      character === "$" &&
      SHELL_EXPANSION_START_PATTERN.test(command[index + 1] ?? "")
    ) {
      activeControl = true;
    } else if (!quote && ";&|<>".includes(character)) {
      activeControl = true;
    }
    if (!quote && WHITESPACE_PATTERN.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += character;
    }
  }
  if (quote) {
    activeControl = true;
  }
  if (token) {
    tokens.push(token);
  }
  return { tokens, activeControl };
}

function commandTokens(command: string): string[] {
  const scanned = scanShell(command.trim());
  return scanned.activeControl ? [] : scanned.tokens;
}

function isOpaquePackageScript(command: string): boolean {
  const tokens = commandTokens(command);
  const executable = (tokens[0] ?? "").toLowerCase();
  const args = tokens.slice(1).map((token) => token.toLowerCase());
  if (executable === "bun") {
    return args[0] === "run" && TEST_SCRIPT_PATTERN.test(args[1] ?? "");
  }
  if (!PACKAGE_SCRIPT_RUNNERS.has(executable)) {
    return false;
  }
  return (
    args[0] === "test" ||
    (args[0] === "run" && TEST_SCRIPT_PATTERN.test(args[1] ?? ""))
  );
}

export function runnerGeneratedArtifactDirectories(
  command: string
): readonly string[] {
  const tokens = commandTokens(command);
  const executable = (tokens[0] ?? "").toLowerCase();
  const args = tokens.slice(1).map((token) => token.toLowerCase());
  if (
    ["pytest", "py.test"].includes(executable) ||
    (["python", "python3"].includes(executable) &&
      args[0] === "-m" &&
      args[1] === "pytest")
  ) {
    return [".pytest_cache", "__pycache__"];
  }
  if (executable === "./gradlew") {
    return [".gradle", "build"];
  }
  if (executable === "dotnet") {
    return ["bin", "obj"];
  }
  if (["cargo", "mvn"].includes(executable)) {
    return ["target"];
  }
  if (executable === "swift") {
    return [".build"];
  }
  return [];
}

/** Conservatively recognizes direct invocations of commonly supported test runners. */
export function isSupportedTestCommand(command: string): boolean {
  const tokens = commandTokens(command);
  if (ENV_ASSIGNMENT_PATTERN.test(tokens[0] ?? "")) {
    return false;
  }
  const executable = (tokens[0] ?? "").toLowerCase();
  const args = tokens.slice(1).map((token) => token.toLowerCase());
  if (["pytest", "py.test"].includes(executable)) {
    return true;
  }
  if (["python", "python3"].includes(executable)) {
    return args[0] === "-m" && args[1] === "pytest";
  }
  if (["jest", "vitest", "mocha", "ava"].includes(executable)) {
    return true;
  }
  if (["bunx", "npx"].includes(executable)) {
    return ["jest", "vitest", "mocha", "ava"].includes(args[0] ?? "");
  }
  if (executable === "bun") {
    return args[0] === "test";
  }
  if (["npm", "pnpm", "yarn"].includes(executable)) {
    return false;
  }
  if (executable === "deno") {
    return args[0] === "test";
  }
  if (["cargo", "go", "dotnet", "mvn", "swift"].includes(executable)) {
    return args[0] === "test";
  }
  if (executable === "./gradlew") {
    return args.some((arg) => arg === "test" || arg.endsWith(":test"));
  }
  return false;
}

function numericCounts(text: string, word: "pass" | "fail"): number[] {
  const pattern = word === "pass" ? PASS_COUNT_PATTERN : FAIL_COUNT_PATTERN;
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((match) => Number(match[1]));
}

function normalizedIntent(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{M}\p{N}_$@/.-]/gu, "");
}

function normalizedTokenSequence(value: string): string[] {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase("und")
      .match(/[\p{L}\p{M}\p{N}_$@]+/gu) ?? []
  ).map(normalizedIntent);
}

function hasNormalizedTokenSequence(haystack: string, needle: string): boolean {
  const haystackTokens = normalizedTokenSequence(haystack);
  const needleTokens = normalizedTokenSequence(needle);
  if (
    needleTokens.length === 0 ||
    needleTokens.length > haystackTokens.length
  ) {
    return false;
  }
  return haystackTokens.some((_, start) =>
    needleTokens.every(
      (token, offset) => haystackTokens[start + offset] === token
    )
  );
}

function intentTerms(values: Array<string | undefined>): Set<string> {
  const terms = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    const bounded = Buffer.from(value)
      .subarray(0, MAX_EDIT_SNIPPET_BYTES)
      .toString("utf8")
      .replace(TRAILING_REPLACEMENT_CHARACTER_PATTERN, "");
    for (const match of bounded.matchAll(
      /[\p{L}\p{M}_$@][\p{L}\p{M}\p{N}_$@/.-]*/gu
    )) {
      const normalized = normalizedIntent(match[0]);
      for (const term of [
        normalized,
        ...normalized.split(INTENT_PATH_SEPARATOR_PATTERN),
      ]) {
        if (
          term.length >= 3 &&
          !INTENT_STOP_WORDS.has(term) &&
          !DIGITS_ONLY_PATTERN.test(term)
        ) {
          terms.add(term);
          if (terms.size >= MAX_REGRESSION_INTENT_ITEMS) {
            return terms;
          }
        }
      }
    }
  }
  return terms;
}

function hasIntentOverlap(left: Set<string>, right: Set<string>): boolean {
  return [...left].some((term) => right.has(term));
}

function trustedIntentAuthorizesRegression(
  trustedTaskIntent: string,
  regressionIntent: string[],
  regressionTitles: string[]
): boolean {
  const trustedTerms = intentTerms([trustedTaskIntent]);
  if (trustedTerms.size === 0) {
    return false;
  }
  const retainedTerms = intentTerms(regressionIntent);
  const overlapCount = [...retainedTerms].filter((term) =>
    trustedTerms.has(term)
  ).length;
  if (overlapCount >= 2) {
    return true;
  }
  if (
    regressionIntent.some((value) => {
      const basename = normalizedIntent(value).split("/").at(-1) ?? "";
      const stem = basename.replace(TEST_FILE_SUFFIX_PATTERN, "");
      return stem.length >= 3 && trustedTerms.has(stem);
    })
  ) {
    return true;
  }

  return regressionTitles.some((title) => {
    const titleTerms = [...intentTerms([title])];
    if (titleTerms.filter((term) => trustedTerms.has(term)).length >= 2) {
      return true;
    }
    return hasNormalizedTokenSequence(trustedTaskIntent, title);
  });
}

function missingReference(text: string): string | undefined {
  for (const pattern of TARGET_MISSING_REFERENCE_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      return normalizedIntent(match[1]);
    }
  }
}

function outputShowsOutcome(
  text: string,
  expected: "red" | "green",
  regressionIntent: Set<string> = new Set(),
  command = "",
  stronglyCorrelatedFailure = false
): boolean {
  const normalized = text.trim();
  const missing = missingReference(normalized);
  const exceptionalFailure =
    INFRASTRUCTURE_FAILURE_PATTERN.test(normalized) ||
    GENERIC_COMPILATION_FAILURE_PATTERN.test(normalized) ||
    missing !== undefined;
  if (
    !normalized ||
    NO_TESTS_PATTERN.test(normalized) ||
    HARD_SETUP_FAILURE_PATTERN.test(normalized) ||
    (exceptionalFailure && !(missing && regressionIntent.has(missing)))
  ) {
    return false;
  }
  const passes = numericCounts(normalized, "pass");
  const failures = numericCounts(normalized, "fail");
  const executable = commandTokens(command)[0]?.toLowerCase();
  const mavenSummary =
    executable === "mvn"
      ? MAVEN_TEST_SUMMARY_PATTERN.exec(normalized)
      : undefined;
  const dotnetSummary =
    executable === "dotnet"
      ? DOTNET_TEST_SUMMARY_PATTERN.exec(normalized)
      : undefined;
  const runnerPass =
    (executable === "swift" && SWIFT_TEST_PASS_PATTERN.test(normalized)) ||
    (executable === "./gradlew" &&
      (GRADLE_TEST_COUNT_PATTERN.test(normalized) ||
        GRADLE_EXECUTED_TEST_TASK_PATTERN.test(normalized)) &&
      GRADLE_BUILD_SUCCESS_PATTERN.test(normalized)) ||
    (mavenSummary !== undefined &&
      Number(mavenSummary[1]) > 0 &&
      Number(mavenSummary[2]) === 0 &&
      Number(mavenSummary[3]) === 0) ||
    (dotnetSummary !== undefined &&
      Number(dotnetSummary[1]) === 0 &&
      Number(dotnetSummary[2]) > 0);
  const runnerFailure =
    (executable === "swift" && SWIFT_TEST_FAIL_PATTERN.test(normalized)) ||
    (executable === "./gradlew" &&
      (GRADLE_TEST_COUNT_PATTERN.test(normalized) ||
        GRADLE_FAILED_TEST_TASK_PATTERN.test(normalized)) &&
      GRADLE_BUILD_FAILURE_PATTERN.test(normalized)) ||
    (mavenSummary !== undefined &&
      (Number(mavenSummary[2]) > 0 || Number(mavenSummary[3]) > 0)) ||
    (dotnetSummary !== undefined && Number(dotnetSummary[1]) > 0);
  const hasPass =
    passes.some((count) => count > 0) ||
    PASS_LINE_PATTERN.test(normalized) ||
    runnerPass;
  const authoritativeFailure =
    failures.some((count) => count > 0) || runnerFailure;
  const hasFailure = authoritativeFailure || FAIL_LINE_PATTERN.test(normalized);
  if (MISSING_FILE_FAILURE_PATTERN.test(normalized)) {
    return (
      expected === "red" && stronglyCorrelatedFailure && authoritativeFailure
    );
  }
  if (expected === "red") {
    return hasFailure;
  }
  return (
    hasPass &&
    !hasFailure &&
    !(
      executable === "./gradlew" &&
      GRADLE_BUILD_FAILURE_PATTERN.test(normalized)
    )
  );
}

function prefixedEvidence(result: TddEvidenceResult): {
  error?: string;
  entries?: Map<string, string>;
} {
  const validation = Array.isArray(result.validation) ? result.validation : [];
  const prefixes = ["RED:", "GREEN:", "COVERAGE:"];
  const entries = new Map<string, string>();
  for (const prefix of prefixes) {
    const matching = validation.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.startsWith(prefix)
    );
    if (matching.length !== 1) {
      return {
        error: `TDD executor result must include exactly one validation entry beginning RED:, GREEN:, and COVERAGE:. Invalid count for ${prefix}`,
      };
    }
    if (!matching[0].slice(prefix.length).trim()) {
      return {
        error: `TDD executor evidence must include non-empty reason text after every prefix. Empty ${prefix}`,
      };
    }
    entries.set(prefix, matching[0]);
  }
  return { entries };
}

const TEST_PATH_PATTERN =
  /(^|[/\\.])(tests?|specs?|__tests__)([/\\.]|$)|(?:^|[/\\])(?:e2e|end-to-end)(?:[/\\]|$)|\.(?:test|spec|case)\.[^/\\]+$|(?:^|[/\\])test_[^/\\]+\.py$|_test\.(?:go|py)$/i;
const READ_ONLY_SHELL_COMMANDS = new Set([
  "cat",
  "find",
  "git",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "tail",
  "wc",
  "which",
]);

function canonicalMutationPath(path: string): string | undefined {
  if (
    !path.trim() ||
    Buffer.byteLength(path) > MAX_MUTATION_PATH_BYTES ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    WINDOWS_NON_RELATIVE_PATH_PATTERN.test(path)
  ) {
    return;
  }
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return;
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length > 0 ? segments.join("/") : undefined;
}

function explicitMutationTargets(call: TddToolCall): string[] | undefined {
  const values = ["path", "file_path", "filePath"]
    .map((key) => call.args[key])
    .filter((value): value is string => typeof value === "string");
  if (values.length === 0 || new Set(values).size !== 1) {
    return;
  }
  const canonical = canonicalMutationPath(values[0]!);
  return canonical ? [canonical] : undefined;
}

function patchMutationTargets(call: TddToolCall): string[] | undefined {
  const values = ["patch", "input", "text"]
    .map((key) => call.args[key])
    .filter((value): value is string => typeof value === "string");
  if (values.length !== 1) {
    return;
  }
  const patch = values[0]!;
  const targets: string[] = [];
  if (PATCH_BEGIN_PATTERN.test(patch) || PATCH_END_PATTERN.test(patch)) {
    if (!(PATCH_BEGIN_PATTERN.test(patch) && PATCH_END_PATTERN.test(patch))) {
      return;
    }
    let previousOperation: string | undefined;
    for (const line of patch.split(PATCH_LINE_SPLIT_PATTERN)) {
      const operation = PATCH_OPERATION_PATTERN.exec(line);
      const move = PATCH_MOVE_PATTERN.exec(line);
      let rawTarget: string | undefined;
      if (operation) {
        previousOperation = operation[1];
        rawTarget = operation[2];
      } else if (move && previousOperation === "Update") {
        previousOperation = undefined;
        rawTarget = move[1];
      } else if (
        line.startsWith("*** ") &&
        !["*** Begin Patch", "*** End Patch", "*** End of File"].includes(
          line.trim()
        )
      ) {
        return;
      }
      if (rawTarget !== undefined) {
        const canonical = canonicalMutationPath(rawTarget);
        if (!canonical) {
          return;
        }
        targets.push(canonical);
        if (targets.length > MAX_MUTATION_TARGETS) {
          return;
        }
      }
    }
  } else {
    const headers = [
      ...patch.matchAll(/^(?:---|\+\+\+)\s+([^\t\r\n]+)(?:\t.*)?$/gm),
    ];
    if (headers.length < 2 || headers.length % 2 !== 0) {
      return;
    }
    for (const match of headers) {
      const raw = match[1]!;
      if (raw === "/dev/null") {
        continue;
      }
      if (
        WHITESPACE_PATTERN.test(raw) ||
        !UNIFIED_PATCH_PATH_PATTERN.test(raw)
      ) {
        return;
      }
      const canonical = canonicalMutationPath(raw.slice(2));
      if (!canonical) {
        return;
      }
      targets.push(canonical);
      if (targets.length > MAX_MUTATION_TARGETS) {
        return;
      }
    }
  }
  return targets.length > 0 ? [...new Set(targets)] : undefined;
}

function mutationTargets(call: TddToolCall): string[] | undefined {
  if (call.mutationTargets) {
    return call.mutationTargets;
  }
  return ["apply_patch", "apply-patch", "applypatch"].includes(call.name)
    ? patchMutationTargets(call)
    : explicitMutationTargets(call);
}

function isSingleRustCfgTestModule(value: string): boolean {
  const marker = RUST_INLINE_TEST_MARKER_PATTERN.exec(value);
  if (!marker) {
    return false;
  }
  const item = value.slice(marker[0].length).trim();
  const openingBrace = RUST_CFG_TEST_MODULE_PATTERN.exec(item);
  if (!openingBrace) {
    return false;
  }
  let depth = 0;
  for (
    let index = openingBrace[0].indexOf("{");
    index < item.length;
    index += 1
  ) {
    const character = item[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return item.slice(index + 1).trim().length === 0;
      }
    }
  }
  return false;
}

function isNarrowRustInlineTestEdit(call: TddToolCall): boolean {
  if (call.name !== "edit" || call.editDeltaTruncated) {
    return false;
  }
  const oldText = call.editOldSnippet ?? call.args.oldText;
  const newText = call.editNewSnippet ?? call.args.newText;
  return (
    typeof oldText === "string" &&
    typeof newText === "string" &&
    isSingleRustCfgTestModule(oldText) &&
    isSingleRustCfgTestModule(newText)
  );
}

function containsOnlyTrailingJsTrivia(value: string): boolean {
  let rest = value.trimStart();
  if (rest.startsWith(";")) {
    rest = rest.slice(1);
  }
  while (rest.trimStart()) {
    rest = rest.trimStart();
    if (rest.startsWith("//")) {
      const newline = rest.indexOf("\n");
      rest = newline < 0 ? "" : rest.slice(newline + 1);
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      if (end < 0) {
        return false;
      }
      rest = rest.slice(end + 2);
    } else {
      return false;
    }
  }
  return true;
}

function isSingleVitestForm(value: string): boolean {
  const opening = value.indexOf("(");
  if (opening < 0) {
    return false;
  }
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = opening; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (lineComment) {
      lineComment = character !== "\n";
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (["'", '"', "`"].includes(character)) {
      quote = character;
    } else if (pairs[character]) {
      stack.push(pairs[character]);
    } else if ([")", "]", "}"].includes(character)) {
      if (stack.pop() !== character) {
        return false;
      }
      if (stack.length === 0) {
        return containsOnlyTrailingJsTrivia(value.slice(index + 1));
      }
    }
  }
  return false;
}

function isStandalonePythonDoctest(value: string): boolean {
  let sawPrompt = false;
  let trailingComments = false;
  for (const rawLine of value.split(PATCH_LINE_SPLIT_PATTERN)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("#")) {
      trailingComments = true;
      continue;
    }
    if (trailingComments) {
      return false;
    }
    if (line.startsWith(">>> ")) {
      sawPrompt = true;
    } else if (
      !(
        sawPrompt &&
        (line.startsWith("... ") || PYTHON_DOCTEST_OUTPUT_PATTERN.test(line))
      )
    ) {
      return false;
    }
  }
  return sawPrompt;
}

function isClearInSourceTestSnippet(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  if (VITEST_TEST_FORM_PATTERN.test(trimmed)) {
    return isSingleVitestForm(trimmed);
  }
  return (
    PYTHON_DOCTEST_FORM_PATTERN.test(trimmed) &&
    isStandalonePythonDoctest(trimmed)
  );
}

function isNarrowInSourceTestEdit(call: TddToolCall, path: string): boolean {
  if (
    call.name !== "edit" ||
    !IN_SOURCE_TEST_PATH_PATTERN.test(path) ||
    call.editDeltaTruncated
  ) {
    return false;
  }
  const oldText = call.editOldSnippet ?? call.args.oldText;
  const newText = call.editNewSnippet ?? call.args.newText;
  return (
    typeof oldText === "string" &&
    typeof newText === "string" &&
    isClearInSourceTestSnippet(oldText) &&
    isClearInSourceTestSnippet(newText) &&
    (oldText.trim().length > 0 || newText.trim().length > 0)
  );
}

interface MutationEffects {
  hasTestTargets: boolean;
  hasProductionTargets: boolean;
  ambiguous: boolean;
}

function boundedMetadataSegments(value: string): string[] {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= MAX_METADATA_SCAN_BYTES) {
    return [value];
  }
  const segmentBytes = Math.floor(
    MAX_METADATA_SCAN_BYTES / MAX_METADATA_SCAN_SEGMENTS
  );
  const lastStart = bytes.byteLength - segmentBytes;
  const starts = Array.from(
    { length: MAX_METADATA_SCAN_SEGMENTS },
    (_, index) =>
      Math.floor((lastStart * index) / (MAX_METADATA_SCAN_SEGMENTS - 1))
  );
  return starts.map((start) =>
    bytes
      .subarray(start, start + segmentBytes)
      .toString("utf8")
      .replace(/^\uFFFD|\uFFFD$/g, "")
  );
}

function boundedRegressionTitles(values: Array<string | undefined>): string[] {
  const titles = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    for (const bounded of boundedMetadataSegments(value)) {
      let suite: string | undefined;
      const retainTitle = (rawTitle: string) => {
        const title = normalizedTokenSequence(rawTitle).join(" ");
        if (title) {
          titles.add(title);
        }
        return title;
      };
      for (const match of bounded.matchAll(JS_TEST_TITLE_PATTERN)) {
        const title = retainTitle(match[2]!);
        if (match[1] === "describe") {
          suite = title;
        } else if (suite && title) {
          retainTitle(`${suite} ${title}`);
        }
        if (titles.size >= MAX_REGRESSION_INTENT_ITEMS) {
          return [...titles];
        }
      }
      for (const pattern of [
        FUNCTION_TEST_TITLE_PATTERN,
        GO_TEST_TITLE_PATTERN,
        GHERKIN_SCENARIO_PATTERN,
      ]) {
        for (const match of bounded.matchAll(pattern)) {
          retainTitle(match[1]!);
          if (titles.size >= MAX_REGRESSION_INTENT_ITEMS) {
            return [...titles];
          }
        }
      }
    }
  }
  return [...titles];
}

function boundedRegressionIntent(values: Array<string | undefined>): string[] {
  const terms = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    for (const bounded of boundedMetadataSegments(value)) {
      for (const match of bounded.matchAll(
        /[\p{L}\p{M}_$@][\p{L}\p{M}\p{N}_$@/.-]*/gu
      )) {
        const term = normalizedIntent(match[0]);
        if (term && Buffer.byteLength(term) <= MAX_REGRESSION_INTENT_BYTES) {
          terms.add(term);
        }
        if (terms.size >= MAX_REGRESSION_INTENT_ITEMS) {
          return [...terms];
        }
      }
    }
  }
  return [...terms];
}

function classifyRustWriteContent(
  content: unknown
): NonNullable<TddToolCall["rustWriteContent"]> {
  if (typeof content !== "string") {
    return "unavailable";
  }
  return RUST_INLINE_TEST_MARKER_ANYWHERE_PATTERN.test(content)
    ? "test"
    : "production";
}

function discreteMutationEffects(call: TddToolCall): MutationEffects {
  if (
    typeof call.hasTestTargets === "boolean" &&
    typeof call.hasProductionTargets === "boolean"
  ) {
    return {
      hasTestTargets: call.hasTestTargets,
      hasProductionTargets: call.hasProductionTargets,
      ambiguous: call.mutationAmbiguous === true,
    };
  }
  const targets = mutationTargets(call);
  if (!targets) {
    return {
      hasTestTargets: true,
      hasProductionTargets: true,
      ambiguous: true,
    };
  }
  let hasTestTargets = false;
  let hasProductionTargets = false;
  let ambiguous = false;
  for (const path of targets) {
    if (call.name === "edit" && call.editDeltaTruncated) {
      hasTestTargets = true;
      hasProductionTargets = true;
      ambiguous = true;
      continue;
    }
    if (TEST_PATH_PATTERN.test(path)) {
      hasTestTargets = true;
      continue;
    }
    if (RUST_SOURCE_PATH_PATTERN.test(path)) {
      if (isNarrowRustInlineTestEdit(call)) {
        hasTestTargets = true;
      } else {
        hasProductionTargets = true;
        const oldText = call.editOldSnippet ?? call.args.oldText;
        const newText = call.editNewSnippet ?? call.args.newText;
        const rustWriteContent =
          call.rustWriteContent ??
          (call.name === "write"
            ? classifyRustWriteContent(call.args.content)
            : undefined);
        if (
          rustWriteContent === "test" ||
          rustWriteContent === "unavailable" ||
          (call.name === "edit" &&
            typeof oldText === "string" &&
            typeof newText === "string" &&
            (RUST_INLINE_TEST_MARKER_ANYWHERE_PATTERN.test(oldText) ||
              RUST_INLINE_TEST_MARKER_ANYWHERE_PATTERN.test(newText)))
        ) {
          hasTestTargets = true;
          ambiguous = true;
        }
      }
      continue;
    }
    if (isNarrowInSourceTestEdit(call, path)) {
      hasTestTargets = true;
      continue;
    }
    hasProductionTargets = true;
    if (
      call.name === "edit" &&
      IN_SOURCE_TEST_PATH_PATTERN.test(path) &&
      ((call.editOldSnippet ?? call.args.oldText) ||
        (call.editNewSnippet ?? call.args.newText))
    ) {
      const oldText = call.editOldSnippet ?? call.args.oldText;
      const newText = call.editNewSnippet ?? call.args.newText;
      if (
        (typeof oldText === "string" && isClearInSourceTestSnippet(oldText)) ||
        (typeof newText === "string" && isClearInSourceTestSnippet(newText))
      ) {
        hasTestTargets = true;
        ambiguous = true;
      }
    }
  }
  return { hasTestTargets, hasProductionTargets, ambiguous };
}

/** Extracts bounded validation metadata without retaining mutation payload text. */
export function normalizeTddToolMetadata(
  name: string,
  rawArgs: Record<string, unknown>
): Pick<
  TddToolCall,
  | "args"
  | "mutationTargets"
  | "hasTestTargets"
  | "hasProductionTargets"
  | "mutationAmbiguous"
  | "rustWriteContent"
  | "editOldSnippet"
  | "editNewSnippet"
  | "editDeltaTruncated"
  | "regressionIntent"
  | "regressionTitles"
  | "mutationProven"
> {
  if (name === "bash") {
    const command =
      typeof rawArgs.command === "string" ? rawArgs.command : undefined;
    const coverageTargets = command
      ? coverageVerificationTargets(command)
      : undefined;
    return {
      args: command ? { command } : {},
      ...(coverageTargets ? { mutationTargets: coverageTargets } : {}),
    };
  }
  if (!MUTATION_TOOLS.has(name)) {
    const rawPath = ["path", "file_path", "filePath"]
      .map((key) => rawArgs[key])
      .find((value): value is string => typeof value === "string");
    const path = rawPath ? canonicalMutationPath(rawPath) : undefined;
    return { args: path ? { path } : {} };
  }
  const transientCall = {
    name,
    args: rawArgs,
  } as TddToolCall;
  const targets = mutationTargets(transientCall);
  const writesRust =
    name === "write" &&
    targets?.some((target) => RUST_SOURCE_PATH_PATTERN.test(target));
  const rustWriteContent = writesRust
    ? classifyRustWriteContent(rawArgs.content)
    : undefined;
  const sourceEdit = name === "edit" && targets?.length === 1;
  const rawOldText =
    sourceEdit && typeof rawArgs.oldText === "string"
      ? rawArgs.oldText
      : undefined;
  const rawNewText =
    sourceEdit && typeof rawArgs.newText === "string"
      ? rawArgs.newText
      : undefined;
  const truncateSnippet = (value: string): string =>
    Buffer.from(value)
      .subarray(0, MAX_EDIT_SNIPPET_BYTES)
      .toString("utf8")
      .replace(TRAILING_REPLACEMENT_CHARACTER_PATTERN, "");
  const editDeltaTruncated =
    (rawOldText !== undefined &&
      Buffer.byteLength(rawOldText) > MAX_EDIT_SNIPPET_BYTES) ||
    (rawNewText !== undefined &&
      Buffer.byteLength(rawNewText) > MAX_EDIT_SNIPPET_BYTES);
  const retainedCall = {
    name,
    args: {},
    ...(targets ? { mutationTargets: targets } : {}),
    ...(rustWriteContent ? { rustWriteContent } : {}),
    ...(rawOldText === undefined
      ? {}
      : { editOldSnippet: truncateSnippet(rawOldText) }),
    ...(rawNewText === undefined
      ? {}
      : { editNewSnippet: truncateSnippet(rawNewText) }),
    ...(editDeltaTruncated ? { editDeltaTruncated: true } : {}),
  } as TddToolCall;
  const effects = discreteMutationEffects(retainedCall);
  const testTarget = targets?.some((target) => TEST_PATH_PATTERN.test(target));
  const addedTestMetadata = [
    retainedCall.editNewSnippet,
    name === "write" && typeof rawArgs.content === "string"
      ? rawArgs.content
      : undefined,
  ];
  const regressionIntent =
    effects.hasTestTargets || testTarget
      ? boundedRegressionIntent(addedTestMetadata)
      : [];
  const oldTitles = new Set(
    boundedRegressionTitles([retainedCall.editOldSnippet])
  );
  const regressionTitles =
    effects.hasTestTargets || testTarget
      ? boundedRegressionTitles(addedTestMetadata).filter(
          (title) => !oldTitles.has(title)
        )
      : [];
  return {
    args: {},
    ...(targets ? { mutationTargets: targets } : {}),
    hasTestTargets: effects.hasTestTargets,
    hasProductionTargets: effects.hasProductionTargets,
    mutationAmbiguous: effects.ambiguous,
    ...(rustWriteContent ? { rustWriteContent } : {}),
    ...(retainedCall.editOldSnippet === undefined
      ? {}
      : { editOldSnippet: retainedCall.editOldSnippet }),
    ...(retainedCall.editNewSnippet === undefined
      ? {}
      : { editNewSnippet: retainedCall.editNewSnippet }),
    ...(editDeltaTruncated ? { editDeltaTruncated: true } : {}),
    ...(regressionIntent.length > 0 ? { regressionIntent } : {}),
    ...(regressionTitles.length > 0 ? { regressionTitles } : {}),
    ...(name === "edit" && rawOldText !== undefined && rawNewText !== undefined
      ? { mutationProven: rawOldText !== rawNewText }
      : {}),
  };
}

/** Reads only explicit tool-result delta markers; success prose is not proof. */
export function mutationResultProvesDelta(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const record = result as Record<string, unknown>;
  if (record.changed === true || record.created === true) {
    return true;
  }
  return mutationResultProvesDelta(record.details);
}

/**
 * Returns the complete, fixed artifact set for a coverage invocation that can
 * be proven with contained pre/post file hashes. Other coverage modes remain
 * mutation-capable and fail closed.
 */
export function coverageVerificationTargets(
  command: string
): string[] | undefined {
  const scanned = scanShell(command);
  if (scanned.activeControl) {
    return;
  }
  const tokens = scanned.tokens;
  const normalized = tokens.map((token) => token.toLowerCase());
  const executable = normalized[0] ?? "";
  let pytestOffset: number | undefined;
  if (["pytest", "py.test"].includes(executable)) {
    pytestOffset = 1;
  } else if (
    ["python", "python3"].includes(executable) &&
    normalized[1] === "-m" &&
    normalized[2] === "pytest"
  ) {
    pytestOffset = 3;
  }
  if (pytestOffset === undefined) {
    return;
  }
  const options = normalized.slice(pytestOffset);
  if (
    !options.some((token) => token === "--cov" || token.startsWith("--cov="))
  ) {
    return;
  }
  const unsafeOptions = [
    "--basetemp",
    "--coverage-dir",
    "--html",
    "--json-report-file",
    "--junit-xml",
    "--junit-path",
    "--junitxml",
    "--output-file",
    "--outputfile",
  ];
  if (
    options.some((token) =>
      unsafeOptions.some(
        (option) => token === option || token.startsWith(`${option}=`)
      )
    )
  ) {
    return;
  }
  for (let index = 0; index < options.length; index += 1) {
    const token = options[index]!;
    if (token === "--cov-report") {
      const reporter = options[index + 1];
      if (!(reporter && PYTEST_TEXT_COVERAGE_REPORT_PATTERN.test(reporter))) {
        return;
      }
      index += 1;
    } else if (
      token.startsWith("--cov-report=") &&
      !PYTEST_TEXT_COVERAGE_REPORT_PATTERN.test(
        token.slice("--cov-report=".length)
      )
    ) {
      return;
    }
  }
  return [".coverage"];
}

export function testCommandHasWriteOption(command: string): boolean {
  const tokens = commandTokens(command);
  const normalized = tokens.map((token) => token.toLowerCase());
  const executable = normalized[0] ?? "";
  const ecosystemWriteOptions: Record<string, string[]> = {
    dotnet: [
      "--blame",
      "--collect",
      "--diag",
      "--logger",
      "--results-directory",
    ],
    mvn: ["-d"],
    "./gradlew": [
      "--profile",
      "--scan",
      "--update-locks",
      "--write-locks",
      "--write-verification-metadata",
    ],
    swift: ["--enable-code-coverage", "--xunit-output"],
  };
  if (
    (ecosystemWriteOptions[executable] ?? []).some((option) =>
      normalized.some(
        (token) => token === option || token.startsWith(`${option}=`)
      )
    ) ||
    (executable === "mvn" && normalized.some((token) => token.startsWith("-d")))
  ) {
    return true;
  }
  const optionWrites = (token: string) =>
    token === "-u" ||
    [
      "--update",
      "--updatesnapshot",
      "--update-snapshot",
      "--update-snapshots",
      "--outputfile",
      "--output-file",
      "--junitxml",
      "--junit-xml",
      "--junit-path",
      "--html",
      "--json-report-file",
      "--coverprofile",
      "-coverprofile",
      "--coverage-dir",
      "--basetemp",
      "--timings",
      "--preload",
      "--require",
      "--import",
      "--loader",
      "--setup-files",
      "--setupfiles",
      "--setupfilesafterenv",
      "--globalsetup",
      "--globalteardown",
    ].some((option) => token === option || token.startsWith(`${option}=`));
  if (normalized.some(optionWrites)) {
    return true;
  }
  if (
    executable === "deno" &&
    normalized.some(
      (token) =>
        token === "-a" ||
        token === "--allow-all" ||
        token === "--allow-net" ||
        token.startsWith("--allow-net=") ||
        token === "--allow-write" ||
        token.startsWith("--allow-write=") ||
        token === "--allow-run" ||
        token.startsWith("--allow-run=") ||
        token === "--allow-ffi" ||
        token.startsWith("--allow-ffi=") ||
        token === "--config" ||
        token.startsWith("--config=") ||
        token === "--permission-set" ||
        token.startsWith("--permission-set=") ||
        token === "--unstable" ||
        token.startsWith("--unstable-")
    )
  ) {
    return true;
  }
  if (
    normalized.some(
      (token, index) =>
        token === "--cov" ||
        token.startsWith("--cov=") ||
        (token === "--cov-report" &&
          COVERAGE_REPORT_WRITE_PATTERN.test(normalized[index + 1] ?? "")) ||
        (token.startsWith("--cov-report=") &&
          COVERAGE_REPORT_WRITE_PATTERN.test(
            token.slice("--cov-report=".length)
          ))
    )
  ) {
    return true;
  }
  if (
    normalized.some(
      (token, index) =>
        ((token.startsWith("--reporter-option=") ||
          token.startsWith("--reporter-options=")) &&
          REPORTER_OUTPUT_PATTERN.test(token)) ||
        (["--reporter-option", "--reporter-options"].includes(token) &&
          REPORTER_OUTPUT_PATTERN.test(normalized[index + 1] ?? ""))
    )
  ) {
    return true;
  }
  if (
    normalized.some(
      (token, index) =>
        token === "--coverage-reporter" &&
        BUN_ARTIFACT_COVERAGE_REPORTER_PATTERN.test(normalized[index + 1] ?? "")
    ) ||
    normalized.some(
      (token) =>
        token.startsWith("--coverage-reporter=") &&
        BUN_ARTIFACT_COVERAGE_REPORTER_PATTERN.test(
          token.slice("--coverage-reporter=".length)
        )
    )
  ) {
    return true;
  }
  if (
    executable !== "bun" &&
    normalized.some(
      (token) => token === "--coverage" || token.startsWith("--coverage=")
    )
  ) {
    return true;
  }
  if (
    normalized.some(
      (token) =>
        token === "--coverage.directory" ||
        token.startsWith("--coverage.directory=")
    )
  ) {
    return true;
  }
  return false;
}

function isProvenCoverageVerification(call: TddToolCall): boolean {
  if (
    call.name !== "bash" ||
    typeof call.args.command !== "string" ||
    call.coverageArtifactProof !== true
  ) {
    return false;
  }
  const expected = coverageVerificationTargets(call.args.command);
  if (
    !expected ||
    call.mutationTargets?.length !== expected.length ||
    !expected.every((path, index) => call.mutationTargets?.[index] === path)
  ) {
    return false;
  }
  const expectedSet = new Set(expected);
  return (call.mutationDelta ?? []).every(
    ({ path }) => expectedSet.has(path) && !TEST_PATH_PATTERN.test(path)
  );
}

function mutationHasProvenDelta(call: TddToolCall): boolean {
  if (call.mutationProven !== undefined) {
    return call.mutationProven;
  }
  if (call.name !== "edit" || call.editDeltaTruncated) {
    return false;
  }
  const oldText = call.editOldSnippet ?? call.args.oldText;
  const newText = call.editNewSnippet ?? call.args.newText;
  return (
    typeof oldText === "string" &&
    typeof newText === "string" &&
    oldText !== newText
  );
}

function isMutationCall(call: TddToolCall): boolean {
  if (MUTATION_TOOLS.has(call.name)) {
    return true;
  }
  if (call.name !== "bash" || typeof call.args.command !== "string") {
    return false;
  }
  const command = call.args.command;
  const scanned = scanShell(command);
  if (scanned.activeControl) {
    return true;
  }
  const tokens = scanned.tokens;
  if (ENV_ASSIGNMENT_PATTERN.test(tokens[0] ?? "")) {
    return true;
  }
  const executable = (tokens[0] ?? "").toLowerCase();
  if (!executable) {
    return true;
  }
  if (isOpaquePackageScript(command)) {
    return true;
  }
  if (isSupportedTestCommand(command)) {
    return testCommandHasWriteOption(command);
  }
  if (executable.includes("/") || executable.includes("\\")) {
    return true;
  }
  // Git can invoke repository/configured helpers even for apparently read-only
  // subcommands, so every shell Git invocation is mutation-capable here.
  if (executable === "git" || !READ_ONLY_SHELL_COMMANDS.has(executable)) {
    return true;
  }
  if (executable === "find") {
    const findActions = new Set([
      "-delete",
      "-exec",
      "-execdir",
      "-fprint",
      "-fprint0",
      "-fprintf",
      "-fls",
      "-ok",
      "-okdir",
    ]);
    if (tokens.slice(1).some((token) => findActions.has(token.toLowerCase()))) {
      return true;
    }
  }
  return false;
}

interface NumericCoverageClaim {
  key: string;
  valid: boolean;
}

function numericCoverageClaims(text: string): NumericCoverageClaim[] {
  const claims: NumericCoverageClaim[] = [];
  COVERAGE_PERCENT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(COVERAGE_PERCENT_PATTERN)) {
    const kind = (match[1] ?? match[4])!.toLowerCase();
    const value = Number(match[2] ?? match[3]);
    claims.push({
      key: `percent:${kind}:${value}`,
      valid: value > 0 && value <= 100,
    });
  }
  COVERAGE_RATIO_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(COVERAGE_RATIO_PATTERN)) {
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    claims.push({
      key: `ratio:${match[3]!.toLowerCase()}:${numerator}/${denominator}`,
      valid: numerator > 0 && denominator > 0 && numerator <= denominator,
    });
  }
  COVERAGE_THRESHOLD_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(COVERAGE_THRESHOLD_PATTERN)) {
    const value = Number(match[1]);
    claims.push({
      key: `threshold:${value}:${match[2]!.toLowerCase()}`,
      valid: value > 0 && value <= 100,
    });
  }
  COVERAGE_COUNT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(COVERAGE_COUNT_PATTERN)) {
    const kind = (match[2] ?? match[3])!.toLowerCase();
    const value = Number(match[1] ?? match[4]);
    claims.push({ key: `count:${kind}:${value}`, valid: value > 0 });
  }
  return claims;
}

function hasMeaningfulCoverageEvidence(
  coverage: string,
  tests: TddToolCall[],
  trajectoryIntent: Set<string>,
  lastImplementationEnd: number,
  finalGreenEnd: number
): boolean {
  const eligibleTests = tests.filter(
    (call) =>
      call.startOrder > lastImplementationEnd &&
      call.endOrder <= finalGreenEnd &&
      !call.isError
  );
  if (NEGATIVE_COVERAGE_PATTERN.test(coverage)) {
    return false;
  }
  const numericClaims = numericCoverageClaims(coverage);
  if (
    numericClaims.length > 0 ||
    NUMERIC_COVERAGE_CLAIM_PATTERN.test(coverage)
  ) {
    if (
      numericClaims.length === 0 ||
      numericClaims.some(({ valid }) => !valid)
    ) {
      return false;
    }
    const observed = new Set(
      eligibleTests
        .filter((call) =>
          outputShowsOutcome(
            call.resultText ?? "",
            "green",
            new Set(),
            call.args.command as string
          )
        )
        .flatMap((call) =>
          numericCoverageClaims((call.resultText ?? "").toLowerCase())
        )
        .filter(({ valid }) => valid)
        .map(({ key }) => key)
    );
    return numericClaims.every(({ key }) => observed.has(key));
  }
  if (TEST_COMMAND_RESULT_PATTERN.test(coverage)) {
    return eligibleTests.some(
      (call) =>
        typeof call.args.command === "string" &&
        coverage.includes(call.args.command.toLowerCase()) &&
        !call.isError &&
        outputShowsOutcome(
          call.resultText ?? "",
          "green",
          new Set(),
          call.args.command as string
        )
    );
  }
  return (
    COVERAGE_KIND_PATTERN.test(coverage) &&
    COVERAGE_ACTION_PATTERN.test(coverage) &&
    NAMED_EVIDENCE_PATTERN.test(coverage) &&
    hasIntentOverlap(intentTerms([coverage]), trajectoryIntent)
  );
}

function evidenceClaims(
  entry: string,
  outcome: "red" | "green",
  command: string
): boolean {
  const detail = entry.slice(entry.indexOf(":") + 1).toLowerCase();
  if (
    !entry.includes(command) ||
    UNAVAILABLE_MARKERS.some((marker) => detail.includes(marker)) ||
    HYPOTHETICAL_MARKERS.some((marker) => detail.includes(marker))
  ) {
    return false;
  }
  return outcome === "red"
    ? RED_CLAIM_PATTERN.test(detail)
    : GREEN_CLAIM_PATTERN.test(detail);
}

function hasUnavailableReason(entry: string): boolean {
  const detail = entry
    .slice(entry.indexOf(":") + 1)
    .trim()
    .toLowerCase();
  // Remove complete marker phrases repeatedly, then punctuation. Word
  // boundaries prevent marker text embedded in a meaningful word from being
  // treated as a marker or stripped (for example, "not runner").
  let markerFound = false;
  let reason = detail;
  for (const marker of UNAVAILABLE_MARKERS_LONGEST_FIRST) {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const markerPattern = new RegExp(`\\b${escaped}\\b`, "g");
    if (reason.search(markerPattern) !== -1) {
      markerFound = true;
      reason = reason.replace(markerPattern, " ");
    }
  }
  return (
    markerFound &&
    reason
      .replace(REASON_CONNECTOR_PATTERN, " ")
      .replace(REASON_SEPARATOR_PATTERN, "")
      .trim().length > 0
  );
}

export function validateTddEvidence(
  result: TddEvidenceResult,
  calls: TddToolCall[],
  captureErrors: string[] = [],
  trustedTaskIntent = ""
): string | undefined {
  const parsed = prefixedEvidence(result);
  if (parsed.error) {
    return parsed.error;
  }
  const entries = parsed.entries!;
  const status = result.status;
  if (!["done", "blocked", "needs_followup"].includes(String(status))) {
    return "TDD executor result has an invalid status.";
  }
  if (
    captureErrors.length > 0 ||
    calls.some(
      (call) =>
        !(Number.isFinite(call.startOrder) && Number.isFinite(call.endOrder)) ||
        call.endOrder <= call.startOrder
    )
  ) {
    return "TDD evidence trajectory capture was incomplete or could not be correlated.";
  }

  const mutations = calls.filter(isMutationCall);
  const needsBlocker = status === "blocked" || status === "needs_followup";
  if (
    needsBlocker &&
    !(
      Array.isArray(result.blockers) &&
      result.blockers.some((item) => typeof item === "string" && item.trim())
    )
  ) {
    return `A ${status} TDD executor result must include a non-empty blocker.`;
  }
  const redUnavailable = hasUnavailableReason(entries.get("RED:")!);
  const greenUnavailable = hasUnavailableReason(entries.get("GREEN:")!);
  const structured = calls.filter((call) => call.name === "structured_output");
  const finalCall = calls.reduce<TddToolCall | undefined>(
    (latest, call) =>
      !latest || call.startOrder > latest.startOrder ? call : latest,
    undefined
  );
  if (structured.length !== 1) {
    return "structured_output must be the sole final tool call with no sibling or later activity.";
  }
  const invalidTerminalOutput =
    structured[0] !== finalCall ||
    calls.some(
      (call) =>
        call !== structured[0] &&
        call.assistantTurn === structured[0]?.assistantTurn
    );
  if (
    status !== "done" &&
    mutations.length === 0 &&
    !calls.some(
      (call) =>
        call.name === "bash" &&
        typeof call.args.command === "string" &&
        isSupportedTestCommand(call.args.command)
    )
  ) {
    if (invalidTerminalOutput) {
      return "structured_output must be the sole final tool call with no sibling or later activity.";
    }
    if (!(redUnavailable && greenUnavailable)) {
      return `A ${status} no-work TDD result must give consistent explicit unavailable/not-run reasons for RED: and GREEN:.`;
    }
    if (!hasUnavailableReason(entries.get("COVERAGE:")!)) {
      return `A ${status} no-work TDD result must include explicit unavailable/not-run COVERAGE: reason evidence.`;
    }
    return;
  }

  const mutationEffects = (call: TddToolCall): MutationEffects => {
    if (MUTATION_TOOLS.has(call.name)) {
      return discreteMutationEffects(call);
    }
    const isTestWrite =
      call.name === "bash" &&
      typeof call.args.command === "string" &&
      isSupportedTestCommand(call.args.command);
    const opaque =
      call.name === "bash" &&
      typeof call.args.command === "string" &&
      isOpaquePackageScript(call.args.command);
    return {
      hasTestTargets: isTestWrite,
      hasProductionTargets: opaque || !isTestWrite,
      ambiguous: opaque,
    };
  };
  const tests = calls.filter(
    (call) =>
      call.name === "bash" &&
      typeof call.args.command === "string" &&
      isSupportedTestCommand(call.args.command) &&
      !testCommandHasWriteOption(call.args.command)
  );
  const coverageVerifications = calls.filter(isProvenCoverageVerification);
  const verificationTests = [...tests, ...coverageVerifications];
  const focusedCommandIntent = (command: string): Set<string> => {
    if (isOpaquePackageScript(command)) {
      return new Set();
    }
    const tokens = commandTokens(command);
    const executable = (tokens[0] ?? "").toLowerCase();
    let offset = tokens.length;
    if (
      executable === "bun" &&
      ["test", "run"].includes(tokens[1]?.toLowerCase() ?? "")
    ) {
      offset = 2;
    } else if (PACKAGE_SCRIPT_RUNNERS.has(executable)) {
      offset = tokens[1]?.toLowerCase() === "run" ? 2 : 1;
    } else if (
      ["pytest", "py.test", "jest", "vitest", "mocha", "ava"].includes(
        executable
      )
    ) {
      offset = 1;
    } else if (["bunx", "npx", "cargo", "go"].includes(executable)) {
      offset = 2;
    } else if (executable === "python" || executable === "python3") {
      offset = 3;
    }
    const targets = tokens
      .slice(offset)
      .filter((token) => !token.startsWith("-") && token !== "./...");
    const terms = new Set<string>();
    for (const target of targets) {
      const normalized = normalizedIntent(target).replace(
        LEADING_DOT_SLASH_PATTERN,
        ""
      );
      if (!normalized) {
        continue;
      }
      if (normalized.includes("/")) {
        terms.add(normalized);
      }
      const basename = normalized.split("/").at(-1) ?? "";
      const stem = basename.replace(TEST_FILE_SUFFIX_PATTERN, "");
      if (
        stem.length >= 3 &&
        !INTENT_STOP_WORDS.has(stem) &&
        !DIGITS_ONLY_PATTERN.test(stem)
      ) {
        terms.add(stem);
      }
    }
    return terms;
  };
  const red = tests.find((call) => {
    const command = call.args.command as string;
    const focusedIntent = focusedCommandIntent(command);
    const candidatePreRedTestMutations = mutations.filter(
      (mutation) =>
        mutation.endOrder < call.startOrder &&
        mutationEffects(mutation).hasTestTargets
    );
    const preRedTestMutations = candidatePreRedTestMutations.filter(
      (mutation) => !mutation.isError && mutation.mutationProven === true
    );
    if (
      candidatePreRedTestMutations.length > 0 &&
      preRedTestMutations.length === 0
    ) {
      return false;
    }
    const retainedRegressionMetadata = preRedTestMutations.flatMap(
      (mutation) => [
        ...(mutation.regressionIntent ?? []),
        ...(mutation.mutationTargets ?? []),
        ...(typeof mutation.args.path === "string" ? [mutation.args.path] : []),
      ]
    );
    const retainedRegressionTitles = preRedTestMutations.flatMap(
      (mutation) => mutation.regressionTitles ?? []
    );
    const mutationIntent = intentTerms(retainedRegressionMetadata);
    const trustedIntent = intentTerms([trustedTaskIntent]);
    if (
      preRedTestMutations.length > 0 &&
      !trustedIntentAuthorizesRegression(
        trustedTaskIntent,
        retainedRegressionMetadata,
        retainedRegressionTitles
      )
    ) {
      return false;
    }
    // Retained test metadata is authoritative; generic command paths cannot
    // correlate an unrelated RED when specific regression terms are available.
    let identityIntent = focusedIntent;
    if (trustedIntent.size > 0) {
      identityIntent = trustedIntent;
    }
    if (retainedRegressionMetadata.length > 0) {
      identityIntent = mutationIntent;
    }
    const expectedIntent = new Set(identityIntent);
    if (
      expectedIntent.size === 0 &&
      candidatePreRedTestMutations.length === 0
    ) {
      for (const term of intentTerms([trustedTaskIntent])) {
        expectedIntent.add(term);
      }
    }
    const outputIntent = intentTerms([call.resultText]);
    const missingIntent = new Set([...expectedIntent]);
    const titleIdentityMatches = retainedRegressionTitles.some((title) =>
      hasNormalizedTokenSequence(call.resultText ?? "", title)
    );
    const overlapCount = [...expectedIntent].filter((term) =>
      outputIntent.has(term)
    ).length;
    const focusedFallbackAllowed =
      retainedRegressionMetadata.length > 0 || trustedIntent.size === 0;
    const missing = missingReference(call.resultText ?? "");
    const exactExpectedSymbol =
      missing !== undefined && expectedIntent.has(missing);
    const intentIdentityMatches =
      overlapCount >= 2 ||
      exactExpectedSymbol ||
      (focusedFallbackAllowed && focusedIntent.size > 0 && overlapCount >= 1);
    return (
      call.isError &&
      expectedIntent.size > 0 &&
      (retainedRegressionTitles.length > 0
        ? titleIdentityMatches
        : intentIdentityMatches) &&
      outputShowsOutcome(
        call.resultText ?? "",
        "red",
        missingIntent,
        command,
        titleIdentityMatches || overlapCount >= 2
      ) &&
      evidenceClaims(entries.get("RED:")!, "red", command)
    );
  });
  const green = tests
    .filter(
      (call) =>
        red &&
        call.startOrder > red.endOrder &&
        !call.isError &&
        call.args.command === red.args.command &&
        outputShowsOutcome(
          call.resultText ?? "",
          "green",
          new Set(),
          call.args.command as string
        ) &&
        evidenceClaims(
          entries.get("GREEN:")!,
          "green",
          call.args.command as string
        )
    )
    .at(-1);
  if (!red && tests.some((call) => call.resultTruncated)) {
    return "Truncated test output did not retain authoritative RED evidence.";
  }
  if (
    red &&
    !green &&
    tests.some(
      (call) =>
        call.resultTruncated &&
        call.startOrder > red.endOrder &&
        call.args.command === red.args.command
    )
  ) {
    return "Truncated test output did not retain authoritative GREEN evidence.";
  }
  const partialCoverageUnavailable = hasUnavailableReason(
    entries.get("COVERAGE:")!
  );
  const greenDetail = entries
    .get("GREEN:")!
    .slice("GREEN:".length)
    .toLowerCase();
  const coverageDetail = entries
    .get("COVERAGE:")!
    .slice("COVERAGE:".length)
    .toLowerCase();
  if (
    status !== "done" &&
    red &&
    !green &&
    greenUnavailable &&
    partialCoverageUnavailable &&
    !GREEN_CLAIM_PATTERN.test(greenDetail) &&
    !COVERAGE_CLAIM_PATTERN.test(coverageDetail)
  ) {
    const hasProductionMutation = mutations.some(
      (call) => mutationEffects(call).hasProductionTargets
    );
    const mutationAfterRed = mutations.some(
      (call) => call.endOrder >= red.startOrder
    );
    if (hasProductionMutation || mutationAfterRed) {
      return `A ${status} RED-only result cannot include an implementation mutation or mutation after RED without final GREEN.`;
    }
    if (invalidTerminalOutput) {
      return "structured_output must be the sole final tool call with no sibling or later activity.";
    }
    return;
  }
  if (!(red && green)) {
    return `A ${status} TDD executor result must bind RED: and GREEN: to the same observed supported test command and actual failing/passing test output.`;
  }
  const unsafeRunnerWorkspace =
    tests.some(
      (call) =>
        call.runnerWorkspaceProof === false ||
        (call.runnerWorkspaceDelta?.length ?? 0) > 0
    ) ||
    coverageVerifications.some(
      (call) =>
        call.runnerWorkspaceProof !== true ||
        (call.runnerWorkspaceDelta?.length ?? 0) > 0
    );
  if (unsafeRunnerWorkspace) {
    return "TDD validation rejects direct test runners that changed relevant workspace files, or whose workspace proof was incomplete.";
  }
  // Selected opaque RED/GREEN package calls are test roles, not implementation
  // effects. Every other mutation-capable shell call in the implementation
  // window is rejected because shell arguments cannot prove workspace targets.
  const implementationMutations = mutations.filter(
    (call) =>
      call !== red && call !== green && !isProvenCoverageVerification(call)
  );
  const testMutationAfterRed = implementationMutations.some(
    (call) =>
      MUTATION_TOOLS.has(call.name) &&
      call.startOrder > red.endOrder &&
      call.endOrder < green.startOrder &&
      mutationEffects(call).hasTestTargets
  );
  const productionBeforeRed = implementationMutations.some(
    (call) =>
      call.startOrder < red.startOrder &&
      mutationEffects(call).hasProductionTargets
  );
  const shellMutationBetween = implementationMutations.some(
    (call) =>
      call.name === "bash" &&
      call.startOrder > red.endOrder &&
      call.endOrder < green.startOrder
  );
  const productionBetween = implementationMutations.some(
    (call) =>
      MUTATION_TOOLS.has(call.name) &&
      !call.isError &&
      mutationHasProvenDelta(call) &&
      mutationEffects(call).hasProductionTargets &&
      call.startOrder > red.endOrder &&
      call.endOrder < green.startOrder
  );
  const mutationOutsideImplementationWindow = implementationMutations.some(
    (call) =>
      call.endOrder >= red.startOrder &&
      !(call.startOrder > red.endOrder && call.endOrder < green.startOrder)
  );
  const actionAfterGreen = calls.some(
    (call) =>
      call !== structured[0] &&
      call.startOrder > green.endOrder &&
      isMutationCall(call) &&
      !isProvenCoverageVerification(call)
  );
  const verificationEnd = Math.max(
    green.endOrder,
    ...calls
      .filter(
        (call) =>
          call.startOrder > green.endOrder &&
          !call.isError &&
          call.name === "bash" &&
          (!isMutationCall(call) || isProvenCoverageVerification(call))
      )
      .map((call) => call.endOrder)
  );
  const lastImplementationEnd = Math.max(
    red.endOrder,
    ...implementationMutations
      .filter((call) => mutationEffects(call).hasProductionTargets)
      .map((call) => call.endOrder)
  );
  const normalizedTestScope = (call: TddToolCall): string =>
    commandTokens(call.args.command as string)
      .map((token) => token.normalize("NFKC").toLocaleLowerCase("und"))
      .join("\0");
  const unresolvedTestFailure = verificationTests.some(
    (failed) =>
      failed.startOrder > lastImplementationEnd &&
      failed.isError &&
      !verificationTests.some(
        (rerun) =>
          rerun.startOrder > failed.endOrder &&
          !rerun.isError &&
          normalizedTestScope(rerun) === normalizedTestScope(failed) &&
          outputShowsOutcome(
            rerun.resultText ?? "",
            "green",
            new Set(),
            rerun.args.command as string
          )
      )
  );
  if (testMutationAfterRed) {
    return "TDD ordering rejects regression-test mutations after RED.";
  }
  if (shellMutationBetween) {
    return "TDD ordering rejects mutation-capable shell calls between RED and GREEN; use a discrete mutation tool for implementation proof.";
  }
  if (productionBeforeRed) {
    return "TDD ordering rejects production mutations before RED; only classified test setup is permitted.";
  }
  if (
    !productionBetween ||
    mutationOutsideImplementationWindow ||
    actionAfterGreen
  ) {
    return "TDD ordering requires a production implementation mutation after RED and final GREEN after the last mutation.";
  }
  if (unresolvedTestFailure) {
    return "TDD validation requires every supported test failure after the last implementation mutation to have a later successful rerun of the same normalized command and scope.";
  }
  if (invalidTerminalOutput) {
    return "structured_output must be the sole final tool call with no sibling or later activity.";
  }

  const coverage = entries
    .get("COVERAGE:")!
    .slice("COVERAGE:".length)
    .trim()
    .toLowerCase();
  const coverageEvidenceIntent = intentTerms(
    verificationTests
      .filter(
        (call) =>
          call.startOrder > lastImplementationEnd &&
          call.endOrder <= verificationEnd &&
          !call.isError
      )
      .flatMap((call) => [call.args.command as string, call.resultText])
  );
  const coverageUnavailable = UNAVAILABLE_MARKERS.some((marker) =>
    coverage.includes(marker)
  );
  const toolingReason = coverage
    .slice(coverage.search(BECAUSE_PATTERN) + "because".length)
    .trim();
  const concreteToolingReason = UNAVAILABLE_MARKERS.reduce(
    (reason, marker) => reason.replaceAll(marker, ""),
    toolingReason
  ).trim();
  const explainedToolingUnavailable =
    coverageUnavailable &&
    TOOLING_PATTERN.test(coverage) &&
    BECAUSE_PATTERN.test(coverage) &&
    intentTerms([concreteToolingReason]).size > 0;
  if (
    HYPOTHETICAL_MARKERS.some((marker) => coverage.includes(marker)) ||
    (coverageUnavailable
      ? !explainedToolingUnavailable
      : !hasMeaningfulCoverageEvidence(
          coverage,
          verificationTests,
          coverageEvidenceIntent,
          lastImplementationEnd,
          verificationEnd
        ))
  ) {
    return `A ${status} TDD executor result must include meaningful actual COVERAGE: evidence.`;
  }
  return;
}
