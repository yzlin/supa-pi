import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  formatWarning,
  lintPlainReport,
  splitSentences,
  TARGET_COMPLIANCE,
} from "./lint";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const rules = (markdown: string) =>
  lintPlainReport(markdown).warnings.map((warning) => warning.rule);

describe("plain-report calibration linter", () => {
  it("separates the compliant and noncompliant fixtures around the target", () => {
    expect(lintPlainReport(fixture("compliant.md")).compliance).toBe(1);
    expect(lintPlainReport(fixture("noncompliant.md")).compliance).toBeLessThan(
      TARGET_COMPLIANCE,
    );
  });

  it("uses the procedural limit for numbered steps only", () => {
    const words = Array.from({ length: 22 }, () => "word").join(" ");
    expect(rules(`1. ${words}.`)).toEqual(["sentence-length"]);
    expect(rules(`- ${words}.`)).toEqual([]);
    expect(rules(`${words}.`)).toEqual([]);
  });

  it("flags passive voice and avoid-words with a suggested fix", () => {
    const result = lintPlainReport("The cache was cleared. We utilize it.");
    expect(result.warnings.map(formatWarning)).toEqual([
      'L1 [passive-voice] "was cleared" → name the actor and use active voice',
      'L1 [avoid-word] "utilize" → use',
    ]);
    expect(result.compliance).toBe(0);
  });

  it("flags telegraph style by article rate, only with enough prose", () => {
    const telegraph = Array.from(
      { length: 12 },
      () => "Tests pass. Lint clean. No push.",
    ).join("\n\n");
    const result = lintPlainReport(telegraph);
    expect(result.articleRate).toBe(0);
    expect(result.warnings.map((warning) => warning.rule)).toEqual([
      "telegraph",
    ]);
    expect(rules("Tests pass. Lint clean.")).toEqual([]);
    expect(lintPlainReport(fixture("compliant.md")).warnings).toEqual([]);
  });

  it("does not treat stative un- adjectives as passive voice", () => {
    expect(rules("Locks are unchanged. The file is untouched.")).toEqual([]);
  });

  it("flags paragraphs over six sentences, joining wrapped lines", () => {
    const paragraph = "One.\nTwo. Three. Four.\nFive. Six. Seven.";
    expect(rules(paragraph)).toEqual(["paragraph-length"]);
    expect(rules(paragraph.replace(" Seven.", ""))).toEqual([]);
  });

  it("skips Exact Text: code, fences, quotes, tables, headings, and paths", () => {
    const markdown = [
      "## The cache was cleared by utilize",
      "```",
      "the cache was cleared",
      "```",
      "> The cache was cleared.",
      "| The cache was cleared |",
      "Run `utilize --was-cleared` on extensions/review/very/long/path.ts now.",
      'The error said "file was not found prior to start".',
    ].join("\n");
    expect(lintPlainReport(markdown).warnings).toEqual([]);
  });

  it("keeps abbreviations inside one sentence", () => {
    expect(splitSentences("Use a tool, e.g. grep. Stop.")).toEqual([
      "Use a tool, e.g. grep.",
      "Stop.",
    ]);
  });

  it("treats text with no prose as fully compliant", () => {
    expect(lintPlainReport("```\ncode\n```").compliance).toBe(1);
  });
});
