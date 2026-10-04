import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { formatWarning, lintPlainReport, TARGET_COMPLIANCE } from "./lint";

const FIXTURES = join(import.meta.dir, "fixtures");

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: bun run eval:plain-report -- [file.md ...]\nLints Plain report prose. Defaults to evals/plain-report/fixtures.",
    );
    return;
  }
  const files =
    args.length > 0
      ? args
      : (await readdir(FIXTURES))
          .filter((name) => name.endsWith(".md"))
          .toSorted()
          .map((name) => join(FIXTURES, name));

  let sentences = 0;
  let flagged = 0;
  let telegraph = 0;
  for (const file of files) {
    const result = lintPlainReport(await readFile(file, "utf8"));
    sentences += result.sentences;
    flagged += result.flaggedSentences;
    if (result.warnings.some((warning) => warning.rule === "telegraph")) {
      telegraph += 1;
    }
    console.log(
      `${relative(process.cwd(), file)}: ${percent(result.compliance)} (${result.sentences - result.flaggedSentences}/${result.sentences} sentences clean; ${result.articleRate.toFixed(1)} articles/100 words)`,
    );
    for (const warning of result.warnings) {
      console.log(`  ${formatWarning(warning)}`);
    }
  }
  const total = sentences === 0 ? 1 : 1 - flagged / sentences;
  console.log(
    `\nOverall: ${percent(total)} clean; target ${percent(TARGET_COMPLIANCE)}; ${telegraph}/${files.length} files telegraph`,
  );
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

if (import.meta.main) {
  await main();
}
